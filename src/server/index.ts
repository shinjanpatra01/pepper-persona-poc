import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import { optionalEnv } from "../lib/env.js";

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
      .map((e) => e.name);
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

      return {
        id,
        name: meta?.name ?? id,
        createdAt: meta?.createdAt ?? null,
        role: spec?.role ?? null,
        objective: spec?.objective ?? null,
        tone: spec?.tone?.style ?? null,
        accent: spec?.voice_profile?.accent ?? null,
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
  return {
    meta: await readJsonIfPresent(join(dir, "persona.json")),
    source: await readIfPresent(join(dir, "source.md")),
    transcript: await readJsonIfPresent(join(dir, "transcript.json")),
    spec: await readJsonIfPresent(join(dir, "agent-spec.json")),
    systemPrompt: await readIfPresent(join(dir, "system-prompt.txt")),
    firstMessage: (await readIfPresent(join(dir, "first-message.txt")))?.trim(),
    assistant: await readJsonIfPresent(join(dir, "vapi-assistant.json")),
    evaluation: await readIfPresent(join(dir, "evaluation.md")),
    call: await readJsonIfPresent(join(dir, "call-result.json")),
  };
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
      hasDeepgram: !!process.env.DEEPGRAM_API_KEY,
      hasLlm: !!(process.env.LLM_API_KEY || process.env.XAI_API_KEY || process.env.OPENAI_API_KEY),
    });
  }

  if (path === "/api/personas") return json(res, await listPersonas());

  if (path === "/api/upload" && req.method === "POST") return handleUpload(req, res);

  const detail = path.match(/^\/api\/persona\/([^/]+)$/);
  if (detail) {
    const dir = safeDir(decodeURIComponent(detail[1]!));
    if (!dir) return json(res, { error: "bad id" }, 400);

    if (req.method === "DELETE") {
      await rm(dir, { recursive: true, force: true });
      return json(res, { ok: true });
    }
    return json(res, await readPersona(dir));
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

createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) json(res, { error: (error as Error).message }, 500);
    else res.end();
  });
}).listen(PORT, () => {
  console.log(`\n  Persona console: http://localhost:${PORT}\n`);
});
