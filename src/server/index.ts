import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import { optionalEnv } from "../lib/env.js";
import {
  buildVoicePayload,
  readVoiceSettings,
  speedRange,
  VoiceOverridesSchema,
  CARTESIA_EMOTIONS,
  CARTESIA_LANGUAGES,
  CARTESIA_MODELS,
  CARTESIA_VOLUME,
} from "../vapi/voiceOverrides.js";

const run = promisify(execFile);

/**
 * Local server for the persona console.
 *
 * PRD 6 asks that every artifact be inspectable and the experiment easy to
 * rerun; page 8 describes a demo that goes recording -> spec -> prompt -> Vapi
 * agent -> live call. This serves that flow. It is deliberately NOT the Pepper
 * dashboard ruled out by PRD 7: no campaigns, no leads, no tenancy, no
 * database. State lives in examples/ as files, exactly as the CLIs leave it.
 */

const ROOT = resolve(process.cwd());
const EXAMPLES = join(ROOT, "examples");
const WEB = join(ROOT, "web");
const PORT = Number(optionalEnv("PORT", "5173"));

/** Refuse absurd uploads rather than filling the disk. */
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

/**
 * Stages the UI may trigger. An allow-list, not free-form command building:
 * this endpoint turns an HTTP request into a child process, so the set of
 * runnable things has to be closed.
 */
const STAGES: Record<string, (dir: string, arg?: string) => string[]> = {
  transcribe: (dir) => ["src/cli/transcribe.ts", join(dir, "audio.mp3"), "--repair"],
  analyze: (dir) => ["src/cli/analyze.ts", join(dir, "transcript.json")],
  voice: (dir) => ["src/cli/analyzeVoice.ts", dir],
  prompt: (dir) => ["src/cli/prompt.ts", join(dir, "agent-spec.json")],
  vapi: (dir) => ["src/cli/vapiCreate.ts", dir],
  call: (dir, arg) => ["src/cli/vapiCall.ts", dir, ...(arg ? [`--to=${arg}`] : [])],
  callstatus: (dir) => ["src/cli/vapiCall.ts", dir, "--status"],
};

/** The full create-a-persona run, in order. */
const PIPELINE: { stage: keyof typeof STAGES; label: string }[] = [
  { stage: "transcribe", label: "Transcribing and separating speakers" },
  { stage: "analyze", label: "Extracting the persona" },
  { stage: "voice", label: "Analysing the voice" },
  { stage: "prompt", label: "Writing the system prompt" },
  { stage: "vapi", label: "Creating the voice agent" },
];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function json(res: ServerResponse, data: unknown, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readIfPresent(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function readJsonIfPresent(path: string) {
  const raw = await readIfPresent(path);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Reject any id that could escape the examples folder. The UI only ever sends
 * folder names, but this endpoint reads and deletes from disk on request, so
 * traversal has to be impossible rather than unlikely.
 */
function safeDir(id: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null;
  const dir = normalize(join(EXAMPLES, id));
  return dir.startsWith(EXAMPLES + "/") ? dir : null;
}

/* ------------------------------------------------------------------ *
 * personas
 * ------------------------------------------------------------------ */

async function listPersonas() {
  let names: string[] = [];
  try {
    names = (await readdir(EXAMPLES, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      /*
       * examples/ is a mounted volume in production, so it is not only ours:
       * ext4 puts a lost+found at the root of every filesystem, and it showed
       * up in the console as a persona named "lost+found". Dotfiles are
       * excluded on the same principle - a directory is a persona only if we
       * put it there.
       */
      .filter((n) => n !== "lost+found" && !n.startsWith("."));
  } catch {
    return [];
  }

  const personas = await Promise.all(
    names.map(async (id) => {
      const dir = join(EXAMPLES, id);
      const has = async (f: string) => !!(await stat(join(dir, f)).catch(() => null));
      const spec = await readJsonIfPresent(join(dir, "agent-spec.json"));
      const meta = await readJsonIfPresent(join(dir, "persona.json"));
      const assistant = await readJsonIfPresent(join(dir, "vapi-assistant.json"));
      const transcript = await readJsonIfPresent(join(dir, "transcript.json"));

      return {
        id,
        name: meta?.name ?? id,
        createdAt: meta?.createdAt ?? null,
        role: spec?.role ?? null,
        objective: spec?.objective ?? null,
        tone: spec?.tone?.style ?? null,
        accent: spec?.voice_profile?.accent ?? null,
        // Surfaced in the list, not just the detail view: which language a
        // persona speaks changes what it is FOR, so it belongs next to the
        // role rather than three clicks in.
        language: transcript?.language
          ? {
              label: transcript.language.label,
              code: transcript.language.language,
              indian: transcript.language.is_indian,
              codeMixed: transcript.language.code_mixed,
              confidence: transcript.language.confidence,
            }
          : null,
        assistantId: assistant?.assistantId ?? null,
        ready: !!assistant?.assistantId,
        artifacts: {
          audio: await has("audio.mp3"),
          transcript: await has("transcript.json"),
          spec: !!spec,
          voice: !!spec?.voice_profile,
          prompt: await has("system-prompt.txt"),
          assistant: !!assistant?.assistantId,
        },
      };
    })
  );

  // Newest first; folders without metadata (created by CLI) sort last.
  return personas.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

async function readPersona(dir: string) {
  const assistant = await readJsonIfPresent(join(dir, "vapi-assistant.json"));
  /*
   * The voice as Vapi actually holds it, so the console shows what the agent is
   * really doing rather than what the pipeline once decided. These drift: a
   * push can fail, or the assistant can be edited in Vapi's own dashboard.
   */
  const liveVoice = assistant?.assistantId
    ? readVoiceSettings((await fetchAssistant(assistant.assistantId))?.voice)
    : null;
  return {
    liveVoice,
    meta: await readJsonIfPresent(join(dir, "persona.json")),
    source: await readIfPresent(join(dir, "source.md")),
    transcript: await readJsonIfPresent(join(dir, "transcript.json")),
    spec: await readJsonIfPresent(join(dir, "agent-spec.json")),
    systemPrompt: await readIfPresent(join(dir, "system-prompt.txt")),
    firstMessage: (await readIfPresent(join(dir, "first-message.txt")))?.trim(),
    idleMessages: await readJsonIfPresent(join(dir, "idle-messages.json")),
    voiceOverrides: await readJsonIfPresent(join(dir, "voice-overrides.json")),
    assistant,
    evaluation: await readIfPresent(join(dir, "evaluation.md")),
    call: await readJsonIfPresent(join(dir, "call-result.json")),
  };
}

/** Collect a small JSON request body. Uploads use the streaming path instead. */
function readBody(req: IncomingMessage, limit = 8192): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) {
        req.destroy();
        rejectBody(new Error("body too large"));
      }
    });
    req.on("end", () => resolveBody(data));
    req.on("error", rejectBody);
  });
}

/**
 * Rename a persona.
 *
 * Only the display name changes. The folder name is the persona's identity -
 * it is baked into the Vapi assistant record and every artifact path - so
 * renaming the folder would mean rewriting all of that to change a label.
 *
 * The Vapi assistant is renamed too so the dashboard does not drift from the
 * console, but a failure there is not fatal: the rename the operator asked for
 * has already succeeded locally.
 */
async function renamePersona(dir: string, name: string) {
  const metaPath = join(dir, "persona.json");
  const meta = (await readJsonIfPresent(metaPath)) ?? {};
  const updated = { ...meta, name, renamedAt: new Date().toISOString() };
  await writeFile(metaPath, JSON.stringify(updated, null, 2) + "\n");

  let vapiRenamed = false;
  const assistant = await readJsonIfPresent(join(dir, "vapi-assistant.json"));
  const apiKey = process.env.VAPI_API_KEY;

  if (assistant?.assistantId && apiKey) {
    try {
      const spec = await readJsonIfPresent(join(dir, "agent-spec.json"));
      const label = `${name} - ${spec?.role ?? ""}`.slice(0, 40).trim();
      const response = await fetch(
        `https://api.vapi.ai/assistant/${assistant.assistantId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: label }),
        }
      );
      vapiRenamed = response.ok;
      if (response.ok) {
        await writeFile(
          join(dir, "vapi-assistant.json"),
          JSON.stringify({ ...assistant, name: label }, null, 2) + "\n"
        );
      }
    } catch {
      // Network trouble renaming a remote label should not fail the rename.
    }
  }

  return { ok: true, name, vapiRenamed };
}

/**
 * Build the browser bundle of the Vapi SDK if it is missing.
 *
 * The talk screen previously imported the SDK from esm.sh at runtime. That
 * pulls a deep dependency graph (the SDK bundles Daily) and any one sub-module
 * failing to fetch kills the whole dynamic import with a single unhelpful
 * "Failed to fetch dynamically imported module". Bundling it locally removes
 * the CDN from the path entirely, so the call screen works offline and cannot
 * break because someone else's CDN had a bad minute.
 */
async function ensureVendorBundle() {
  const bundle = join(WEB, "vendor", "vapi.js");
  if (await stat(bundle).catch(() => null)) return;

  console.log("  building the Vapi browser bundle (first run)...");
  try {
    await run("npx", [
      "esbuild", "src/vendor/vapi-entry.js",
      "--bundle", "--format=esm", "--platform=browser",
      "--define:process.env.NODE_ENV=\"production\"",
      "--minify",
      `--outfile=${bundle}`,
    ], { cwd: ROOT });
    console.log("  bundle ready.");
  } catch (error) {
    console.error(
      "  could not build the Vapi bundle; the talk screen will not work.\n  " +
        (error as Error).message
    );
  }
}

/* ------------------------------------------------------------------ *
 * upload
 * ------------------------------------------------------------------ */

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "persona";
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let n = 2;
  while (await stat(join(EXAMPLES, candidate)).catch(() => null)) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

/**
 * Accept a dropped media file and normalise it to audio.mp3.
 *
 * The browser sends raw bytes with the name in a header rather than multipart
 * form data - multipart would mean writing a parser or taking a dependency,
 * and there is exactly one file per request. ffmpeg then strips any video
 * track, so an mp4 screen recording of a call works the same as a wav.
 */
async function handleUpload(req: IncomingMessage, res: ServerResponse) {
  const rawName = req.headers["x-persona-name"];
  const rawFile = req.headers["x-filename"];
  const personaName = decodeURIComponent(
    (Array.isArray(rawName) ? rawName[0] : rawName) || "Untitled persona"
  ).slice(0, 80);
  const originalName = decodeURIComponent(
    (Array.isArray(rawFile) ? rawFile[0] : rawFile) || "upload"
  );

  const ext = (extname(originalName) || ".bin").toLowerCase().slice(0, 6);
  const id = await uniqueSlug(personaName);
  const dir = join(EXAMPLES, id);
  await mkdir(dir, { recursive: true });

  const uploadPath = join(dir, `source-upload${ext}`);
  const audioPath = join(dir, "audio.mp3");

  // Stream to disk so a large video never sits in memory.
  await new Promise<void>((resolveWrite, rejectWrite) => {
    const out = createWriteStream(uploadPath);
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) {
        out.destroy();
        req.destroy();
        rejectWrite(new Error("File is larger than 300 MB."));
      }
    });
    req.pipe(out);
    out.on("finish", () => resolveWrite());
    out.on("error", rejectWrite);
    req.on("error", rejectWrite);
  });

  try {
    // -vn drops any video stream; the pipeline only ever wants audio.
    await run("ffmpeg", [
      "-y", "-loglevel", "error",
      "-i", uploadPath,
      "-vn", "-acodec", "libmp3lame", "-q:a", "4",
      audioPath,
    ]);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(
      `Could not read that file as audio. ffmpeg said: ${(error as Error).message.slice(0, 300)}`
    );
  } finally {
    await rm(uploadPath, { force: true });
  }

  // Duration, so the UI can warn about clips too short to characterise.
  let seconds = 0;
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      audioPath,
    ]);
    seconds = Math.round(Number(stdout.trim()) || 0);
  } catch {
    // ffprobe is optional; a missing duration is not worth failing the upload.
  }

  const createdAt = new Date().toISOString();
  await writeFile(
    join(dir, "persona.json"),
    JSON.stringify({ name: personaName, createdAt, originalName, seconds }, null, 2) + "\n"
  );
  await writeFile(
    join(dir, "source.md"),
    `# ${personaName}\n\n` +
      `| | |\n|---|---|\n` +
      `| Source file | ${originalName} |\n` +
      `| Uploaded | ${createdAt} |\n` +
      `| Duration | ${seconds}s |\n\n` +
      `Uploaded through the persona console and converted to mono mp3.\n`
  );

  json(res, { id, name: personaName, seconds });
}

/* ------------------------------------------------------------------ *
 * running stages
 * ------------------------------------------------------------------ */

function sse(res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  return (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function spawnStage(
  args: string[],
  onLog: (text: string) => void,
  onClose: (code: number | null) => void
) {
  const child = spawn("npx", ["tsx", ...args], { cwd: ROOT, env: process.env });
  child.stdout.on("data", (c) => onLog(c.toString()));
  child.stderr.on("data", (c) => onLog(c.toString()));
  child.on("close", onClose);
  child.on("error", (e) => {
    onLog(`\nFailed to start: ${e.message}\n`);
    onClose(1);
  });
  return child;
}

/** Run one stage and stream its output. */
function runOne(res: ServerResponse, stage: string, dir: string, arg?: string) {
  const build = STAGES[stage];
  if (!build) return json(res, { error: `Unknown stage "${stage}"` }, 400);

  const send = sse(res);
  const args = build(dir.replace(ROOT + "/", ""), arg);
  send("log", `$ npx tsx ${args.join(" ")}\n`);

  const child = spawnStage(args, (t) => send("log", t), (code) => {
    send("done", { code });
    res.end();
  });
  res.on("close", () => child.kill());
}

/**
 * Run the whole create-a-persona pipeline, one stage at a time.
 *
 * Sequential because each stage consumes the previous stage's file, and it
 * stops at the first failure rather than pushing a half-built persona to Vapi.
 * Step events let the UI show which of the five stages is running without
 * making the operator read the log.
 */
function runPipeline(res: ServerResponse, dir: string) {
  const send = sse(res);
  const relative = dir.replace(ROOT + "/", "");
  let index = 0;
  let cancelled = false;
  let current: ReturnType<typeof spawnStage> | null = null;

  const next = () => {
    if (cancelled) return;
    if (index >= PIPELINE.length) {
      send("done", { code: 0 });
      return res.end();
    }

    const { stage, label } = PIPELINE[index]!;
    send("step", { index, total: PIPELINE.length, label, state: "running" });

    const args = STAGES[stage]!(relative);
    send("log", `\n$ npx tsx ${args.join(" ")}\n`);

    current = spawnStage(args, (t) => send("log", t), (code) => {
      if (cancelled) return;
      if (code !== 0) {
        send("step", { index, total: PIPELINE.length, label, state: "failed" });
        send("done", { code });
        return res.end();
      }
      send("step", { index, total: PIPELINE.length, label, state: "done" });
      index++;
      next();
    });
  };

  res.on("close", () => {
    cancelled = true;
    current?.kill();
  });

  next();
}

/* ------------------------------------------------------------------ *
 * static + audio
 * ------------------------------------------------------------------ */

async function serveStatic(res: ServerResponse, urlPath: string) {
  const file = urlPath === "/" ? "index.html" : urlPath.slice(1);
  if (file.includes("..")) return json(res, { error: "nope" }, 400);

  try {
    const body = await readFile(join(WEB, file));
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      // Never cache. This is a local console you edit while it runs, and a
      // stale module served from disk cache is indistinguishable from a bug -
      // it already cost one debugging cycle on the Vapi bundle.
      "Cache-Control": "no-store, must-revalidate",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

/** Byte ranges, so the player can show a duration and seek. */
async function serveAudio(res: ServerResponse, dir: string, range?: string) {
  let body: Buffer;
  try {
    body = await readFile(join(dir, "audio.mp3"));
  } catch {
    return res.writeHead(404).end();
  }

  const match = range?.match(/bytes=(\d*)-(\d*)/);
  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : body.length - 1;
    const slice = body.subarray(start, end + 1);
    res.writeHead(206, {
      "Content-Type": "audio/mpeg",
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${body.length}`,
      "Content-Length": slice.length,
    });
    return res.end(slice);
  }

  res.writeHead(200, {
    "Content-Type": "audio/mpeg",
    "Accept-Ranges": "bytes",
    "Content-Length": body.length,
  });
  res.end(body);
}

/* ------------------------------------------------------------------ *
 * editing a live persona
 * ------------------------------------------------------------------ */

/** PATCH the Vapi assistant, returning whether the remote actually changed. */
async function patchAssistant(assistantId: string, body: unknown) {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) return { ok: false as const, error: "VAPI_API_KEY is not set." };
  const response = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    return {
      ok: false as const,
      error: `Vapi rejected the update: ${await response.text()}`,
    };
  }
  return { ok: true as const, error: undefined };
}

/** Read the assistant as Vapi currently has it, or null if that fails. */
async function fetchAssistant(assistantId: string) {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) return null;
  try {
    const response = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/**
 * Save a hand-edited system prompt.
 *
 * The generated prompt is a first draft, not a verdict. Reading one and seeing
 * exactly which line makes the agent sound wrong is the normal case, and until
 * now acting on it meant editing the file and re-pushing from the CLI - so in
 * practice the persona stayed as the model first wrote it.
 *
 * The edit goes to the same file the pipeline writes, so the CLI, the console
 * and Vapi cannot drift apart, and it is pushed to the live assistant
 * immediately: an edit you have to remember to deploy is one you will forget
 * to deploy. Re-running the prompt stage overwrites it, which is why the UI
 * says so out loud.
 */
async function savePrompt(dir: string, systemPrompt: string) {
  const text = systemPrompt.trim();
  if (!text) return { error: "The system prompt cannot be empty." };

  await writeFile(join(dir, "system-prompt.txt"), text + "\n");

  const assistant = await readJsonIfPresent(join(dir, "vapi-assistant.json"));
  if (!assistant?.assistantId) {
    return { ok: true, pushed: false, note: "Saved. No Vapi agent exists yet." };
  }

  /*
   * The model block is replaced wholesale, because Vapi keeps the system
   * prompt inside model.messages and patching a nested array is a replace
   * anyway. Reading the current model first preserves the provider and model
   * the assistant was created with, rather than silently resetting them to
   * whatever this process's env says today.
   */
  const current = await fetchAssistant(assistant.assistantId);
  let model: Record<string, unknown> = {
    provider: "openai",
    model: optionalEnv("VAPI_MODEL", "gpt-5.6-luna"),
  };
  if (current?.model) {
    const { messages: _drop, ...rest } = current.model;
    model = rest;
  }

  const result = await patchAssistant(assistant.assistantId, {
    model: { ...model, messages: [{ role: "system", content: text }] },
  });

  await writeFile(
    join(dir, "vapi-assistant.json"),
    JSON.stringify(
      {
        ...assistant,
        systemPromptWords: text.split(/\s+/).filter(Boolean).length,
        promptEditedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );

  return result.ok
    ? { ok: true, pushed: true }
    : { ok: true, pushed: false, note: `Saved locally. ${result.error}` };
}

/**
 * Change any part of the voice on the live agent.
 *
 * Everything the pipeline decided about the voice is a starting point rather
 * than a measurement: the gender comes from an analyser's impression of the
 * recording, the speed from dividing words-per-minute by a tuning constant, and
 * the voice itself is one UUID picked per language and gender out of a
 * catalogue of hundreds. Whether any of it sounds like the person on the tape
 * can only be settled by hearing it, so all of it is editable here.
 *
 * Edits are stored as a PATCH, not a snapshot - only the fields someone
 * actually changed. Anything untouched keeps following the pipeline, instead of
 * being frozen at whatever it happened to be the first time the page loaded.
 */
async function saveVoice(dir: string, patch: unknown) {
  const parsed = VoiceOverridesSchema.safeParse(patch);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  if (!Object.keys(parsed.data).length) return { error: "Nothing to change." };

  const overridesPath = join(dir, "voice-overrides.json");
  const existing = (await readJsonIfPresent(overridesPath)) ?? {};
  const merged: Record<string, unknown> = { ...existing, ...parsed.data };
  // An explicit null means "clear this", which is different from "leave alone".
  for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];

  // Persisted so re-running vapi:create does not quietly undo a listening
  // judgement.
  await writeFile(overridesPath, JSON.stringify(merged, null, 2) + "\n");

  const assistant = await readJsonIfPresent(join(dir, "vapi-assistant.json"));
  if (!assistant?.assistantId) {
    return { ok: true, voice: merged, pushed: false, note: "Saved. No Vapi agent yet." };
  }

  /*
   * The live voice object is the base, not the pipeline's derivation.
   *
   * Vapi holds the whole voice as one object, so a patch has to send all of it
   * - and what is live may already differ from what the pipeline would compute
   * today. Reading it first means an edit changes exactly the field it names.
   */
  const current = await fetchAssistant(assistant.assistantId);
  const base = readVoiceSettings(current?.voice);
  if (!base?.voiceId) {
    return {
      ok: true,
      voice: merged,
      pushed: false,
      note:
        "Saved locally, but the assistant's current voice could not be read, " +
        "so nothing was pushed. Re-run vapi:create to apply it.",
    };
  }

  const payload = buildVoicePayload(
    {
      provider: base.provider === "cartesia" ? "cartesia" : "azure",
      voiceId: base.voiceId,
      speed: base.speed ?? 1,
      model: base.model ?? undefined,
      language: base.language ?? undefined,
      rationale: [],
    },
    merged
  );

  const result = await patchAssistant(assistant.assistantId, { voice: payload });
  return result.ok
    ? { ok: true, voice: payload, pushed: true }
    : { ok: true, voice: merged, pushed: false, note: `Saved locally. ${result.error}` };
}

/**
 * Place a real outbound phone call from the console.
 *
 * The web call ("Talk") and a phone call are not the same test, which is the
 * reason this exists alongside it. A browser call runs on a good mic through an
 * unconstrained codec; a phone call goes through 8kHz narrowband, real network
 * jitter and a carrier. Personas that sound convincing in the browser routinely
 * fall apart on the phone, and the phone is the only one a customer will ever
 * hear.
 *
 * One call at a time, to a number typed by a person. There is no dialling list
 * and no queue here on purpose: this is a test harness for a persona, not an
 * outbound campaign.
 */
async function placePhoneCall(dir: string, to: string) {
  const assistant = await readJsonIfPresent(join(dir, "vapi-assistant.json"));
  if (!assistant?.assistantId) {
    return { error: "No Vapi agent exists for this persona yet." };
  }
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) return { error: "VAPI_API_KEY is not set." };

  /*
   * E.164 or nothing.
   *
   * A number without its country code reaches whoever holds it in the carrier's
   * default country, which on an outbound dialler is a stranger's phone
   * ringing. Rejecting here is cheaper than apologising there.
   */
  const number = to.replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(number)) {
    return {
      error:
        `"${to}" is not a valid number. Use full international format ` +
        "including the country code, e.g. +919876543210.",
    };
  }

  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID?.trim();
  if (!phoneNumberId) {
    return {
      error:
        "VAPI_PHONE_NUMBER_ID is not set, so there is no number to dial from. " +
        "List yours with GET https://api.vapi.ai/phone-number.",
    };
  }

  const response = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      assistantId: assistant.assistantId,
      phoneNumberId,
      customer: { number },
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    /*
     * "Does Not Exist" means the assistant is gone from Vapi while the persona
     * folder still names it - which happens whenever assistants are deleted, or
     * the API key is swapped for a different Vapi account, since ids are scoped
     * per account. It is entirely recoverable by re-running the vapi stage, so
     * it is reported as that rather than as a raw 400 nobody can act on.
     */
    if (/Does Not Exist|Couldn't Get Assistant/i.test(text)) {
      return {
        error:
          "This persona's Vapi agent no longer exists — it was deleted, or the " +
          "Vapi account changed. Recreate it and the number will dial.",
        needsAgent: true,
      };
    }
    return { error: `Vapi rejected the call: ${text}` };
  }

  const call: any = await response.json();
  // Same filename the CLI writes, so both paths leave one history behind
  // rather than two that disagree.
  await writeFile(
    join(dir, "call-result.json"),
    JSON.stringify({ callId: call.id, to: number, ...call }, null, 2) + "\n"
  );

  /*
   * Keep every call id we place, not just the last one.
   *
   * Vapi returns phone calls with assistantId set to null - the id is simply
   * absent from the record - so there is no way to ask "which calls belong to
   * this persona" after the fact. The only reliable link is the one we make at
   * dial time, which means writing it down. Without this the latency panel is
   * permanently empty for exactly the calls that carry the best metrics.
   */
  const historyPath = join(dir, "calls.json");
  const history: any[] = (await readJsonIfPresent(historyPath)) ?? [];
  await writeFile(
    historyPath,
    JSON.stringify(
      [{ callId: call.id, to: number, at: new Date().toISOString() }, ...history].slice(0, 50),
      null,
      2
    ) + "\n"
  );
  return { ok: true, callId: call.id, to: number, status: call.status ?? null };
}

/** Poll a call already placed, for status, transcript and recording. */
async function readPhoneCall(callId: string) {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) return { error: "VAPI_API_KEY is not set." };
  const r = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(callId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) return { error: `Vapi could not return that call: ${await r.text()}` };
  const c: any = await r.json();
  return {
    ok: true,
    id: c.id,
    status: c.status ?? null,
    endedReason: c.endedReason ?? null,
    startedAt: c.startedAt ?? null,
    endedAt: c.endedAt ?? null,
    transcript: c.transcript ?? null,
    recordingUrl: c.recordingUrl ?? null,
  };
}

/**
 * Where the time goes on a call, per turn.
 *
 * "The agent reacts late" is four different bugs wearing the same coat: the
 * transcriber can be slow to emit words, the endpointing can be waiting out
 * silence that already ended, the model can be thinking, or the voice can be
 * slow to make sound. They are fixed in four different places, and guessing
 * which one is at fault is how the same latency work gets done three times.
 *
 * Vapi records all four per turn. This surfaces them rather than making anyone
 * open the dashboard, because the number that matters is not the average - it
 * is which component owns the average.
 */
async function callLatency(dir: string) {
  const assistant = await readJsonIfPresent(join(dir, "vapi-assistant.json"));
  if (!assistant?.assistantId) {
    return { calls: [], note: "No Vapi agent exists yet, so there are no calls." };
  }
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) return { error: "VAPI_API_KEY is not set." };

  const fetchCalls = async (query: string) => {
    const r = await fetch(`https://api.vapi.ai/call?${query}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) throw new Error(await r.text());
    const body = await r.json();
    return Array.isArray(body) ? body : [];
  };

  /*
   * Asked for by assistant, then checked by hand.
   *
   * Vapi's assistantId filter has been observed returning an empty list for an
   * assistant that demonstrably has calls, so a single filtered request is not
   * trustworthy enough to render "no calls yet" from - that message would send
   * someone hunting for a bug in their own agent. The unfiltered page is the
   * cross-check, and the two are merged by id.
   */
  /*
   * Three sources, because no single one is trustworthy.
   *
   *   1. The ids we wrote down when dialling. The only link that survives Vapi
   *      returning phone calls with a null assistantId, and the only one that
   *      works for the calls carrying the richest metrics.
   *   2. The assistantId filter. Correct when it answers, but it has been seen
   *      returning nothing for an assistant that demonstrably has calls.
   *   3. An unfiltered page, matched by hand, as the cross-check.
   *
   * Merged by id. Rendering "no calls yet" off any one of these alone would
   * send someone hunting for a bug in their agent that is not there.
   */
  const merged = new Map<string, any>();
  try {
    const history: any[] = (await readJsonIfPresent(join(dir, "calls.json"))) ?? [];
    const lastCall = await readJsonIfPresent(join(dir, "call-result.json"));
    const knownIds = [
      ...new Set(
        [...history.map((h) => h?.callId), lastCall?.callId].filter(
          (x): x is string => typeof x === "string"
        )
      ),
    ].slice(0, 10);

    // Fetched one by one: a call id resolves reliably even when the list
    // endpoint will not return the same call.
    const fetched = await Promise.all(
      knownIds.map(async (callId) => {
        const r = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(callId)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        return r.ok ? await r.json() : null;
      })
    );
    for (const c of fetched) if (c?.id) merged.set(c.id, c);

    /*
     * Each source fails on its own.
     *
     * These are three independent guesses at the same question, so one of them
     * erroring says nothing about the other two - and letting it throw would
     * discard calls already found and render an empty panel over a working
     * lookup. Found this the honest way: a malformed assistantId 400s the
     * filter query, and the whole panel went blank despite the ids we had.
     */
    try {
      const byAssistant = await fetchCalls(
        `assistantId=${encodeURIComponent(assistant.assistantId)}&limit=10`
      );
      for (const c of byAssistant) merged.set(c.id, c);
    } catch {
      /* filter unavailable; the recorded ids above still stand */
    }

    if (!merged.size) {
      try {
        const recent = await fetchCalls("limit=100");
        for (const c of recent) {
          if (c.assistantId === assistant.assistantId) merged.set(c.id, c);
        }
      } catch {
        /* nothing more to try */
      }
    }
  } catch (e: any) {
    return { error: `Could not read calls from Vapi: ${e.message}` };
  }
  const calls: any[] = [...merged.values()];
  const rows = calls.map((c) => {
    // Vapi files these under artifact, not on the call itself.
    const pm = c.artifact?.performanceMetrics ?? {};
    const turns: any[] = pm.turnLatencies ?? [];
    return {
      id: c.id,
      startedAt: c.startedAt ?? c.createdAt ?? null,
      endedReason: c.endedReason ?? null,
      type: c.type ?? null,
      turns: turns.length,
      averages: {
        transcriber: pm.transcriberLatencyAverage ?? null,
        endpointing: pm.endpointingLatencyAverage ?? null,
        model: pm.modelLatencyAverage ?? null,
        voice: pm.voiceLatencyAverage ?? null,
        total: pm.turnLatencyAverage ?? null,
      },
      interruptions: {
        user: pm.numUserInterrupted ?? null,
        assistant: pm.numAssistantInterrupted ?? null,
      },
      turnLatencies: turns.map((t) => ({
        transcriber: t.transcriberLatency ?? null,
        endpointing: t.endpointingLatency ?? null,
        model: t.modelLatency ?? null,
        voice: t.voiceLatency ?? null,
        total: t.turnLatency ?? null,
      })),
    };
  });

  return {
    calls: rows.filter((r) => r.turns > 0),
    // A call with no turns is one where nobody spoke after the greeting. Worth
    // saying, rather than showing an empty page that looks like a failure.
    emptyCalls: rows.filter((r) => r.turns === 0).length,
  };
}

/**
 * The Cartesia voice catalogue, proxied.
 *
 * Voice ids are account-scoped UUIDs, so the only way to choose one is to see
 * the list - and the list is nine hundred entries long, which is why this
 * filters by language and returns the fields a person actually picks on:
 * gender, accent and Cartesia's own description of what the voice is for.
 *
 * Proxied rather than called from the browser because the Cartesia key would
 * otherwise have to be shipped to the page, and it is a write-capable key.
 */
async function cartesiaVoices(language: string | null) {
  const key = process.env.CARTESIA_API_KEY;
  if (!key) {
    return {
      error:
        "CARTESIA_API_KEY is not set, so the voice catalogue cannot be listed. " +
        "Voices can still be set by id.",
    };
  }
  const voices: any[] = [];
  let after: string | undefined;
  // Paginated at 100; the catalogue is ~900, and one language is a small slice.
  for (let page = 0; page < 12; page++) {
    const url = new URL("https://api.cartesia.ai/voices/");
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("starting_after", after);
    const response = await fetch(url, {
      headers: { "X-API-Key": key, "Cartesia-Version": "2024-11-13" },
    });
    if (!response.ok) return { error: `Cartesia rejected the request: ${await response.text()}` };
    const body: any = await response.json();
    const data: any[] = body.data ?? [];
    voices.push(...data);
    if (!body.has_more || !data.length) break;
    after = data[data.length - 1].id;
  }

  const wanted = language ? language.split("-")[0] : null;
  return {
    voices: voices
      .filter((v) => !wanted || v.language === wanted)
      .map((v) => ({
        id: v.id,
        name: v.name,
        // Cartesia says "masculine"/"feminine"; the console speaks in the same
        // terms the provider does rather than inventing a mapping.
        gender: v.gender ?? null,
        language: v.language,
        description: v.description ?? "",
        country: v.country ?? null,
        isPro: !!v.is_pro,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/* ------------------------------------------------------------------ *
 * routing
 * ------------------------------------------------------------------ */

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === "/api/config") {
    // Only the PUBLIC Vapi key reaches the browser; it is designed for that.
    // The private key never leaves this process.
    return json(res, {
      vapiPublicKey: process.env.VAPI_PUBLIC_KEY ?? null,
      llmModel: process.env.LLM_MODEL ?? null,
      hasVapi: !!process.env.VAPI_API_KEY,
      // Whether outbound dialling is configured at all, so the console can say
      // so instead of offering a button that always fails.
      hasPhoneNumber: !!process.env.VAPI_PHONE_NUMBER_ID,
      hasDeepgram: !!process.env.DEEPGRAM_API_KEY,
      hasLlm: !!(process.env.LLM_API_KEY || process.env.XAI_API_KEY || process.env.OPENAI_API_KEY),
    });
  }

  if (path === "/api/personas") return json(res, await listPersonas());

  // What the voice controls are allowed to offer, straight from the values Vapi
  // validates against, so the console cannot present a choice that 400s.
  if (path === "/api/voice-options") {
    return json(res, {
      models: CARTESIA_MODELS,
      languages: CARTESIA_LANGUAGES,
      emotions: CARTESIA_EMOTIONS,
      volume: CARTESIA_VOLUME,
      speed: { azure: speedRange("azure"), cartesia: speedRange("cartesia") },
      hasCartesiaKey: !!process.env.CARTESIA_API_KEY,
    });
  }

  if (path === "/api/cartesia/voices") {
    const result = await cartesiaVoices(url.searchParams.get("language"));
    return json(res, result, result.error ? 400 : 200);
  }

  if (path === "/api/upload" && req.method === "POST") return handleUpload(req, res);

  const detail = path.match(/^\/api\/persona\/([^/]+)$/);
  if (detail) {
    const dir = safeDir(decodeURIComponent(detail[1]!));
    if (!dir) return json(res, { error: "bad id" }, 400);

    if (req.method === "DELETE") {
      await rm(dir, { recursive: true, force: true });
      return json(res, { ok: true });
    }

    if (req.method === "PATCH") {
      const body = JSON.parse(await readBody(req) || "{}");
      const name = String(body.name ?? "").trim().slice(0, 80);
      if (!name) return json(res, { error: "Name cannot be empty." }, 400);
      return json(res, await renamePersona(dir, name));
    }

    return json(res, await readPersona(dir));
  }

  const promptRoute = path.match(/^\/api\/persona\/([^/]+)\/prompt$/);
  if (promptRoute && req.method === "PUT") {
    const dir = safeDir(decodeURIComponent(promptRoute[1]!));
    if (!dir) return json(res, { error: "bad id" }, 400);
    const body = JSON.parse((await readBody(req, 200_000)) || "{}");
    const result = await savePrompt(dir, String(body.systemPrompt ?? ""));
    return json(res, result, result.error ? 400 : 200);
  }

  // Kept as its own route because the speed slider predates the rest of the
  // voice controls; it is the same saver underneath.
  const speedRoute = path.match(/^\/api\/persona\/([^/]+)\/speed$/);
  if (speedRoute && req.method === "PUT") {
    const dir = safeDir(decodeURIComponent(speedRoute[1]!));
    if (!dir) return json(res, { error: "bad id" }, 400);
    const body = JSON.parse((await readBody(req)) || "{}");
    const result = await saveVoice(dir, { speed: Number(body.speed) });
    return json(res, result, result.error ? 400 : 200);
  }

  const callRoute = path.match(/^\/api\/persona\/([^/]+)\/call$/);
  if (callRoute && req.method === "POST") {
    const dir = safeDir(decodeURIComponent(callRoute[1]!));
    if (!dir) return json(res, { error: "bad id" }, 400);
    const body = JSON.parse((await readBody(req)) || "{}");
    const result = await placePhoneCall(dir, String(body.to ?? ""));
    return json(res, result, (result as any).error ? 400 : 200);
  }

  const callStatus = path.match(/^\/api\/call\/([^/]+)$/);
  if (callStatus) {
    const result = await readPhoneCall(decodeURIComponent(callStatus[1]!));
    return json(res, result, (result as any).error ? 400 : 200);
  }

  const latencyRoute = path.match(/^\/api\/persona\/([^/]+)\/latency$/);
  if (latencyRoute) {
    const dir = safeDir(decodeURIComponent(latencyRoute[1]!));
    if (!dir) return json(res, { error: "bad id" }, 400);
    const result = await callLatency(dir);
    return json(res, result, (result as any).error ? 400 : 200);
  }

  const voiceRoute = path.match(/^\/api\/persona\/([^/]+)\/voice$/);
  if (voiceRoute && req.method === "PUT") {
    const dir = safeDir(decodeURIComponent(voiceRoute[1]!));
    if (!dir) return json(res, { error: "bad id" }, 400);
    const result = await saveVoice(dir, JSON.parse((await readBody(req)) || "{}"));
    return json(res, result, result.error ? 400 : 200);
  }

  const audio = path.match(/^\/api\/audio\/([^/]+)$/);
  if (audio) {
    const dir = safeDir(decodeURIComponent(audio[1]!));
    if (!dir) return res.writeHead(400).end();
    return serveAudio(res, dir, req.headers.range);
  }

  const pipeline = path.match(/^\/api\/pipeline\/([^/]+)$/);
  if (pipeline) {
    const dir = safeDir(decodeURIComponent(pipeline[1]!));
    if (!dir) return json(res, { error: "bad id" }, 400);
    return runPipeline(res, dir);
  }

  const stage = path.match(/^\/api\/run\/([^/]+)\/([^/]+)$/);
  if (stage) {
    const dir = safeDir(decodeURIComponent(stage[2]!));
    if (!dir) return json(res, { error: "bad id" }, 400);
    // Only a plausible phone number is accepted; spawn avoids a shell anyway.
    const raw = url.searchParams.get("arg") ?? undefined;
    const arg = raw && /^\+?[0-9\s()-]{6,20}$/.test(raw) ? raw.trim() : undefined;
    return runOne(res, stage[1]!, dir, arg);
  }

  return serveStatic(res, path);
}

await ensureVendorBundle();

createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) json(res, { error: (error as Error).message }, 500);
    else res.end();
  });
}).listen(PORT, () => {
  console.log(`\n  Persona console: http://localhost:${PORT}\n`);
});
