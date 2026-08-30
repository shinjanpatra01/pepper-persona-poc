import { Blob } from "/blob.js";

/**
 * Persona console.
 *
 * Three screens, hash-routed:
 *   #/            list of personas
 *   #/new         drop a recording, watch the pipeline build a persona
 *   #/talk/<id>   speak to that persona, blob only
 *   #/detail/<id> the artifacts behind a persona (PRD 6 inspectability)
 *
 * Persona artifacts live on disk under examples/ because the pipeline CLIs
 * write files there. localStorage holds only UI state - theme, last screen -
 * which is what keeps a reload from feeling like a reset.
 */

const store = {
  get theme() {
    return document.documentElement.dataset.theme;
  },
  set theme(v) {
    document.documentElement.dataset.theme = v;
    localStorage.setItem("pepper.theme", v);
  },
  get lastRoute() {
    return localStorage.getItem("pepper.route") || "#/";
  },
  set lastRoute(v) {
    localStorage.setItem("pepper.route", v);
  },
};

const state = {
  config: {},
  personas: [],
  vapi: null,
  blob: null,
  call: null,
  /*
   * The widgets the current talk screen is drawing into.
   *
   * The Vapi client is created once and outlives every screen, so its event
   * handlers cannot close over the elements that existed when it was made -
   * screenTalk builds a fresh button, status line and blob each time it runs,
   * and the handlers would go on updating the detached originals. That looked
   * exactly like a slow connection: the call was live and audible while the
   * screen still said "connecting". Handlers read this instead, so they always
   * write to whatever is on screen now.
   */
  ui: null,
};

/* ---------------- tiny dom helper ---------------- */

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};

const api = (path, opts) => fetch(path, opts).then((r) => r.json());

/**
 * replaceChildren stringifies null into the literal text "null", unlike the
 * el() helper above. Every screen builds its children with conditionals, so
 * they all go through here instead.
 */
const mount = (target, ...kids) =>
  target.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
const app = () => document.getElementById("app");
const go = (hash) => { location.hash = hash; };
const initials = (name) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "P";

function setCrumb(text) {
  document.getElementById("crumb").textContent = text ? "/ " + text : "";
}

/* ---------------- screen: persona list ---------------- */

async function screenList() {
  setCrumb("");
  state.personas = await api("/api/personas");

  const missing = [];
  if (!state.config.hasDeepgram) missing.push("DEEPGRAM_API_KEY");
  if (!state.config.hasLlm) missing.push("LLM_API_KEY");
  if (!state.config.hasVapi) missing.push("VAPI_API_KEY");

  mount(app(),
    el("div", { class: "title-row" },
      el("h1", {}, "Personas"),
      el("button", { class: "btn solid", onclick: () => go("#/new") }, "Create persona")
    ),

    missing.length
      ? el("div", { class: "notice" },
          `Missing from .env: ${missing.join(", ")}. Creating a persona will fail until these are set.`)
      : null,

    state.personas.length === 0
      ? el("div", { class: "empty-state" },
          el("div", {}, "No personas yet."),
          el("div", { class: "small", style: "margin-top:8px" },
            "Drop a call recording and one gets built from it."))
      : el("div", {},
          ...state.personas.map((p) =>
            el("div", { class: "persona", onclick: () => go(p.ready ? `#/talk/${p.id}` : `#/detail/${p.id}`) },
              el("div", { class: "avatar" }, initials(p.name)),
              el("div", { class: "body" },
                el("div", { class: "nm" }, p.name),
                el("div", { class: "meta" },
                  p.role
                    ? [p.role, p.tone, p.accent,
                       p.language && p.language.code !== "en"
                         ? p.language.label + (p.language.codeMixed ? " + English" : "")
                         : null,
                      ].filter(Boolean).join(" · ")
                    : "not processed yet")
              ),
              el("div", { class: "state" }, p.ready ? "Talk →" : "Incomplete"),
              el("button", {
                class: "btn ghost small",
                title: "Rename",
                onclick: (e) => { e.stopPropagation(); startRename(e.target, p); },
              }, "Rename"),
              el("button", {
                class: "btn ghost small",
                title: "Delete",
                onclick: (e) => { e.stopPropagation(); removePersona(p); },
              }, "✕")
            )
          ))
  );
}

/**
 * Inline rename. Editing in place rather than through a browser prompt(),
 * which cannot be styled and reads as an error dialog.
 */
function startRename(button, p) {
  const row = button.closest(".persona");
  const nameEl = row.querySelector(".nm");
  if (row.querySelector("input")) return;

  const input = el("input", { class: "rename", value: p.name, maxlength: "80" });
  nameEl.replaceChildren(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = async (save) => {
    if (settled) return;
    settled = true;
    const value = input.value.trim();

    if (!save || !value || value === p.name) {
      nameEl.textContent = p.name;
      return;
    }

    nameEl.textContent = value;
    const result = await api(`/api/persona/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: value }),
    });
    if (result.error) {
      nameEl.textContent = p.name;
      alert(result.error);
      return;
    }
    screenList();
  };

  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

async function removePersona(p) {
  if (!confirm(`Delete "${p.name}" and all its artifacts?`)) return;
  await fetch(`/api/persona/${p.id}`, { method: "DELETE" });
  screenList();
}

/* ---------------- screen: landing ---------------- */

const HOW = [
  ["Record", "Any call recording. Audio or video, any length."],
  ["Separate", "Speakers split apart, then corrected by conversational logic."],
  ["Extract", "Tone, strategy, objection handling and voice, as structured data."],
  ["Speak", "A voice agent that behaves recognisably like the original."],
];

function screenLanding() {
  setCrumb("");

  const canvas = el("canvas", { id: "blob", style: "width:200px;height:200px" });

  mount(app(),
    el("section", { class: "hero" },
      canvas,
      el("h1", {}, "Turn a call recording into a voice agent."),
      el("p", { class: "lede" },
        "Drop in a recording of someone doing their job on the phone. " +
        "Their tone, tactics, pacing and accent are reverse-engineered into " +
        "a structured persona, then rebuilt as an agent you can call."),
      el("div", { class: "row", style: "justify-content:center;margin-top:8px" },
        el("button", { class: "btn solid", onclick: () => go("#/new") }, "Create a persona"),
        el("button", { class: "btn", onclick: () => go("#/personas") }, "View personas"))
    ),

    el("section", { class: "how" },
      ...HOW.map(([title, body], i) =>
        el("div", { class: "how-item" },
          el("div", { class: "n" }, String(i + 1).padStart(2, "0")),
          el("div", { class: "t" }, title),
          el("div", { class: "b" }, body)))
    ),

    el("p", { class: "small muted center", style: "margin-top:40px" },
      "Every intermediate artifact stays inspectable: transcript, agent spec, " +
      "voice profile and the generated prompt.")
  );

  // A slow idle blob, the same component the talk screen uses, so the landing
  // page previews what a call looks like instead of describing it.
  const blob = new Blob(canvas);
  state.blob = blob;
  blob.setState("idle");
  blob.start();
}

/* ---------------- screen: create ---------------- */

const STEP_LABELS = [
  "Transcribing and separating speakers",
  "Extracting the persona",
  "Analysing the voice",
  "Writing the system prompt",
  "Creating the voice agent",
];

function screenNew() {
  setCrumb("new");

  const nameInput = el("input", { placeholder: "e.g. Cold call closer", maxlength: "80" });
  const fileInput = el("input", { type: "file", accept: "audio/*,video/*", style: "display:none" });
  const status = el("div", { class: "small muted", style: "margin-top:14px" });

  let chosen = null;

  const drop = el("div", { class: "drop" },
    el("div", { class: "big" }, "Drop a call recording"),
    el("div", { class: "hint" }, "mp3, wav, m4a, mp4, mov — or click to choose")
  );

  const setFile = (file) => {
    if (!file) return;
    chosen = file;
    drop.replaceChildren(
      el("div", { class: "big" }, file.name),
      el("div", { class: "hint" }, `${(file.size / 1048576).toFixed(1)} MB — click to replace`)
    );
    if (!nameInput.value) {
      nameInput.value = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").slice(0, 80);
    }
    startBtn.disabled = false;
  };

  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    setFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener("change", () => setFile(fileInput.files[0]));

  const startBtn = el("button", {
    class: "btn solid", disabled: true,
    onclick: () => createPersona(chosen, nameInput.value.trim() || "Untitled persona", status),
  }, "Create persona");

  mount(app(),
    el("div", { class: "title-row" },
      el("h1", {}, "New persona"),
      el("button", { class: "btn ghost", onclick: () => go("#/personas") }, "Cancel")
    ),
    drop,
    fileInput,
    el("div", { style: "height:22px" }),
    el("div", { class: "field" },
      el("label", {}, "Name"),
      nameInput
    ),
    el("div", { class: "row" }, startBtn),
    status
  );
}

/**
 * Upload, then run all five stages, showing which one is live.
 *
 * The upload is a plain PUT of the bytes with the name in a header: there is
 * one file per request, so multipart would mean a parser for no gain.
 */
async function createPersona(file, name, status) {
  if (!file) return;

  mount(app(),
    el("div", { class: "title-row" }, el("h1", {}, name)),
    el("div", { class: "card", id: "steps" }),
    el("pre", { class: "log", id: "log" }, "")
  );

  const stepsBox = document.getElementById("steps");
  const log = document.getElementById("log");
  const stepEls = STEP_LABELS.map((label, i) =>
    el("div", { class: "step pending" },
      el("div", { class: "dot" }, ""),
      el("div", {}, label))
  );
  mount(stepsBox,
    el("div", { class: "step running" }, el("div", { class: "dot" }, ""), el("div", {}, "Uploading and converting")),
    ...stepEls
  );

  const append = (text) => {
    log.textContent += text;
    log.scrollTop = log.scrollHeight;
  };

  let id;
  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": encodeURIComponent(file.name),
        "X-Persona-Name": encodeURIComponent(name),
      },
      body: file,
    });
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(body.error || "upload failed");
    id = body.id;

    const upload = stepsBox.firstChild;
    upload.className = "step done";
    upload.firstChild.textContent = "✓";
    append(`Converted to audio.mp3 (${body.seconds}s)\n`);

    if (body.seconds && body.seconds < 45) {
      append(
        `\nNote: ${body.seconds}s is short. The PRD suggests 2-10 minutes; ` +
        `a clip this brief gives the persona extraction very little to work with.\n`
      );
    }
  } catch (error) {
    stepsBox.firstChild.className = "step failed";
    append(`\nUpload failed: ${error.message}\n`);
    stepsBox.append(el("div", { style: "margin-top:14px" },
      el("button", { class: "btn", onclick: () => go("#/new") }, "Try again")));
    return;
  }

  // Stream the five pipeline stages.
  const source = new EventSource(`/api/pipeline/${id}`);

  source.addEventListener("step", (e) => {
    const { index, state: st } = JSON.parse(e.data);
    const node = stepEls[index];
    if (!node) return;
    node.className = `step ${st}`;
    node.firstChild.textContent = st === "done" ? "✓" : st === "failed" ? "!" : "";
  });

  source.addEventListener("log", (e) => append(JSON.parse(e.data)));

  source.addEventListener("done", (e) => {
    const { code } = JSON.parse(e.data);
    source.close();
    if (code === 0) {
      append("\nPersona ready.\n");
      stepsBox.append(el("div", { class: "row", style: "margin-top:16px" },
        el("button", { class: "btn solid", onclick: () => go(`#/talk/${id}`) }, "Talk to it"),
        el("button", { class: "btn", onclick: () => go("#/personas") }, "All personas")));
    } else {
      append(`\nPipeline stopped (exit ${code}). The artifacts produced so far are kept.\n`);
      stepsBox.append(el("div", { class: "row", style: "margin-top:16px" },
        el("button", { class: "btn", onclick: () => go(`#/detail/${id}`) }, "Inspect what was built"),
        el("button", { class: "btn ghost", onclick: () => go("#/personas") }, "Back")));
    }
  });

  source.onerror = () => {
    append("\nLost connection to the server.\n");
    source.close();
  };
}

/* ---------------- screen: talk ---------------- */

async function screenTalk(id) {
  const data = await api(`/api/persona/${id}`);
  const name = data.meta?.name ?? id;
  setCrumb(name);

  const canvas = el("canvas", { id: "blob" });
  const status = el("div", { class: "status" }, "Ready when you are.");
  const caption = el("div", { class: "caption" });

  const talkBtn = el("button", { class: "btn solid" }, "Start call");
  const backBtn = el("button", { class: "btn ghost", onclick: () => go("#/personas") }, "Back");
  const detailBtn = el("button", { class: "btn ghost", onclick: () => go(`#/detail/${id}`) }, "Details");

  mount(app(),
    el("div", { class: "talk" },
      el("h2", {}, name),
      el("div", { class: "role" }, data.spec?.role ?? ""),
      canvas,
      status,
      caption,
      el("div", { class: "row" }, talkBtn, detailBtn, backBtn)
    )
  );

  const blob = new Blob(canvas);
  state.blob = blob;
  // Point the long-lived Vapi handlers at this screen straight away, not only
  // once the button is pressed: a call started here and left running would
  // otherwise report its end to the previous screen's widgets.
  state.ui = { button: talkBtn, status, caption, blob };
  blob.start();

  const assistantId = data.assistant?.assistantId;
  if (!assistantId) {
    status.textContent = "This persona has no Vapi agent yet.";
    talkBtn.disabled = true;
    return;
  }
  if (!state.config.vapiPublicKey) {
    status.textContent = "Set VAPI_PUBLIC_KEY in .env to talk from the browser.";
    talkBtn.disabled = true;
    return;
  }

  talkBtn.onclick = () => toggleCall(assistantId, talkBtn, status, caption, blob);
}

async function toggleCall(assistantId, button, status, caption, blob) {
  if (state.call) {
    state.vapi?.stop();
    return;
  }

  state.ui = { button, status, caption, blob };

  button.disabled = true;
  status.textContent = "connecting…";
  blob.setState("connecting");

  try {
    if (!state.vapi) {
      // Bundled locally (npm run build:vendor). Importing this from a CDN
      // meant the whole call screen depended on someone else's uptime and on
      // a deep dependency graph resolving in the browser; it failed with an
      // opaque "Failed to fetch dynamically imported module".
      const { default: Vapi } = await import("/vendor/vapi.js");
      state.vapi = new Vapi(state.config.vapiPublicKey);

      state.vapi.on("call-start", () => markConnected());

      state.vapi.on("call-end", () => {
        state.call = null;
        const ui = state.ui;
        if (!ui) return;
        ui.button.disabled = false;
        ui.button.textContent = "Start call";
        ui.status.textContent = "call ended";
        ui.blob.setState("idle");
        ui.blob.setLevel(0);
      });

      // The blob is driven by real output loudness rather than a canned
      // animation, so silence looks like silence.
      state.vapi.on("volume-level", (v) => state.ui?.blob.setLevel(v));

      state.vapi.on("speech-start", () => {
        // Audio before call-start is still a connected call; say so.
        markConnected();
        if (!state.ui) return;
        state.ui.blob.setState("speaking");
        state.ui.status.textContent = "speaking";
      });
      state.vapi.on("speech-end", () => {
        if (!state.ui) return;
        state.ui.blob.setState("listening");
        state.ui.status.textContent = "listening";
        state.ui.blob.setLevel(0);
      });

      state.vapi.on("message", (m) => {
        if (m.type === "transcript" && m.transcriptType === "final") {
          state.ui?.caption.replaceChildren(
            el("span", { class: "who" }, m.role === "assistant" ? "agent" : "you"),
            document.createTextNode(m.transcript)
          );
        }
      });

      state.vapi.on("error", (e) => {
        state.call = null;
        const ui = state.ui;
        if (!ui) return;
        ui.button.disabled = false;
        ui.button.textContent = "Start call";
        ui.blob.setState("idle");
        ui.status.textContent =
          "error: " + (e?.errorMsg || e?.message || JSON.stringify(e));
      });
    }

    await state.vapi.start(assistantId);
    // start() resolving means the call exists. If call-start was missed or is
    // slow, the button would otherwise stay disabled under "connecting" for a
    // call the user can already hear.
    markConnected();
  } catch (error) {
    button.disabled = false;
    blob.setState("idle");
    status.textContent = "could not start: " + error.message;
  }
}

/** Flip the screen to a live call. Idempotent: several events can report it. */
function markConnected() {
  if (state.call) return;
  state.call = true;
  const ui = state.ui;
  if (!ui) return;
  ui.button.disabled = false;
  ui.button.textContent = "End call";
  ui.status.textContent = "listening";
  ui.blob.setState("listening");
}

/* ---------------- screen: detail ---------------- */

/**
 * The persona detail screen, in three tabs.
 *
 * It used to be one column of eight cards, and the order was the order the
 * pipeline happened to produce things in: recording, spec, language, voice
 * heard, signature phrases, prompt, voice controls, full transcript. That made
 * the two things you actually do repeatedly - edit the prompt, change the voice
 * - sit in the middle of a long scroll, below reference material you read once
 * and never again, and above a transcript that can run to hundreds of turns.
 *
 * The split is by what you came here to do:
 *
 *   Tune       the loop: edit the prompt, change the voice, call, repeat.
 *   Persona    what the pipeline extracted. Read once, checked when surprised.
 *   Transcript the source recording's words. Long, and its own thing.
 *
 * The tab lives in the URL rather than in a variable, so a reload keeps your
 * place and the back button steps between tabs the way it looks like it should.
 */
const DETAIL_TABS = [
  { key: "tune", label: "Tune" },
  { key: "persona", label: "Persona" },
  { key: "transcript", label: "Transcript" },
  { key: "latency", label: "Latency" },
];

async function screenDetail(id, tab = "tune") {
  const d = await api(`/api/persona/${id}`);
  const name = d.meta?.name ?? id;
  setCrumb(name);
  const s = d.spec;
  const active = DETAIL_TABS.some((t) => t.key === tab) ? tab : "tune";

  const tabBar = el("nav", { class: "tabs" },
    ...DETAIL_TABS.map((t) => {
      // The transcript tab carries its size, because "long" is the thing worth
      // knowing before you click it.
      const count = t.key === "transcript" && d.transcript
        ? ` ${d.transcript.turns.length}`
        : "";
      return el("button", {
        class: `tab${t.key === active ? " on" : ""}`,
        onclick: () => go(`#/detail/${encodeURIComponent(id)}/${t.key}`),
      }, t.label + count);
    }));

  const panes = {
    tune: () => [
      d.systemPrompt
        ? promptEditor(id, d)
        : el("div", { class: "card" },
            el("h3", {}, "System prompt"),
            el("div", { class: "muted" }, "Not generated yet.")),

      d.assistant?.assistantId ? phoneCall(id, d) : null,

      d.assistant?.assistantId
        ? voiceControls(id, d)
        : el("div", { class: "card" },
            el("h3", {}, "Voice of the live agent"),
            el("div", { class: "muted" },
              "No Vapi agent exists yet, so there is nothing to tune. " +
              "Run vapi:create for this persona first.")),

      el("div", { class: "card" },
        el("h3", {}, "Source recording"),
        el("div", { class: "small muted", style: "margin-bottom:10px" },
          "The voice being recreated. Worth replaying right after a change, " +
          "because the question is never whether the agent sounds good - it is " +
          "whether it sounds like this."),
        el("audio", { controls: true, preload: "metadata", src: `/api/audio/${id}` })),
    ],

    persona: () => [
      s ? el("div", { class: "card" },
        el("h3", {}, "Persona"),
        el("table", {},
          tr("role", s.role),
          tr("objective", s.objective),
          tr("target customer", s.target_customer)),
        el("div", { style: "margin-top:12px" },
          chip(s.tone.style),
          chip(`formality ${s.tone.formality}`),
          chip(`energy ${s.tone.energy}`),
          chip(`warmth ${s.tone.warmth}`),
          chip(`aggressiveness ${s.objection_handling.aggressiveness}`),
          chip(`persistence ${s.objection_handling.persistence}`))
      ) : el("div", { class: "card" },
        el("h3", {}, "Persona"),
        el("div", { class: "muted" }, "Not extracted yet.")),

      s?.evidence?.signature_phrases?.length ? el("div", { class: "card" },
        el("h3", {}, "Signature phrases"),
        el("div", { class: "small muted", style: "margin-bottom:10px" },
          "Verbatim from the recording."),
        ...s.evidence.signature_phrases.map((p) => el("div", { class: "chip" }, `"${p}"`))
      ) : null,

      s?.voice_profile ? el("div", { class: "card" },
        // "heard", not "voice": the Tune tab also has a voice card, but that one
        // CHANGES it. This only reports what the analyser found in the audio.
        el("h3", {}, "Voice heard in the recording"),
        el("table", {},
          tr("accent", `${s.voice_profile.accent} (${s.voice_profile.accent_code})`),
          tr("gender", s.voice_profile.perceived_gender),
          tr("pace", s.voice_profile.perceived_pace),
          tr("register", s.voice_profile.emotional_register),
          d.transcript?.prosody?.agent
            ? tr("measured rate", `${d.transcript.prosody.agent.words_per_minute} words/min`)
            : null)
      ) : null,

      d.transcript?.language ? el("div", { class: "card" },
        el("h3", {}, "Language"),
        el("table", {},
          tr("detected", `${d.transcript.language.label} (${d.transcript.language.language})`),
          tr("code-mixed", d.transcript.language.code_mixed ? "yes, English mixed in" : "no"),
          tr("confidence", `${d.transcript.language.confidence} — ${d.transcript.language.detected_by}`),
          tr("transcribed by", d.transcript.transcribed_by ?? "—")),
        // Every detector's verdict, not just the winner: a wrong routing
        // decision is only fixable if you can see which signal caused it.
        el("div", { style: "margin-top:12px" },
          ...d.transcript.language.signals.map((sig) =>
            el("div", { class: "muted", style: "margin-bottom:4px" },
              `[${sig.source}] ${sig.detail}`))),
        ...(d.transcript.language.notes ?? []).map((n) =>
          el("div", { class: "muted", style: "margin-top:6px" }, `! ${n}`))
      ) : null,
    ],

    latency: () => [latencyPanel(id, d)],

    transcript: () => [
      d.transcript ? el("div", { class: "card" },
        el("h3", {}, `Transcript — ${d.transcript.turns.length} turns`),
        ...d.transcript.turns.map((t) =>
          el("div", { class: `turn ${t.speaker}` },
            el("div", { class: "who" }, t.speaker),
            el("div", { class: "txt" }, t.text)))
      ) : el("div", { class: "card" },
        el("h3", {}, "Transcript"),
        el("div", { class: "muted" }, "Not transcribed yet.")),
    ],
  };

  mount(app(),
    el("div", { class: "title-row" },
      el("h1", {}, name),
      el("div", { class: "row" },
        el("button", {
          class: "btn ghost small",
          onclick: async () => {
            const next = prompt("Rename persona", name);
            if (!next || !next.trim() || next.trim() === name) return;
            await api(`/api/persona/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: next.trim() }),
            });
            screenDetail(id, active);
          },
        }, "Rename"),
        d.assistant?.assistantId
          ? el("button", { class: "btn solid", onclick: () => go(`#/talk/${id}`) }, "Talk")
          : null,
        el("button", { class: "btn ghost", onclick: () => go("#/personas") }, "Back"))
    ),
    tabBar,
    ...panes[active]()
  );
}

/**
 * The system prompt, editable in place.
 *
 * Saving writes the same file the pipeline writes and pushes it to the live
 * Vapi agent, so the next call uses it - there is no separate deploy step to
 * forget. The warning about regeneration is shown rather than enforced: the
 * pipeline overwriting a hand edit is fine as long as nobody is surprised by
 * it.
 */
function promptEditor(id, d) {
  const box = el("textarea", { class: "prompt-edit", spellcheck: "false" });
  box.value = d.systemPrompt;

  const note = el("span", { class: "small muted" });
  const save = el("button", { class: "btn solid small" }, "Save and push");
  const revert = el("button", { class: "btn ghost small" }, "Revert");

  revert.onclick = () => {
    box.value = d.systemPrompt;
    note.textContent = "Reverted to the last saved version.";
  };

  save.onclick = async () => {
    save.disabled = true;
    note.textContent = "saving…";
    try {
      const r = await api(`/api/persona/${id}/prompt`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemPrompt: box.value }),
      });
      if (r.error) note.textContent = r.error;
      else {
        d.systemPrompt = box.value.trim();
        note.textContent = r.pushed
          ? "Saved and pushed to the live agent."
          : r.note ?? "Saved.";
      }
    } catch (e) {
      note.textContent = "Could not save: " + e.message;
    }
    save.disabled = false;
  };

  return el("div", { class: "card" },
    el("h3", {}, "System prompt"),
    d.firstMessage ? el("div", { class: "small muted", style: "margin-bottom:10px" },
      `Opens with: "${d.firstMessage}"`) : null,
    box,
    el("div", { class: "row", style: "margin-top:10px" }, save, revert, note),
    el("div", { class: "small muted", style: "margin-top:8px" },
      "Re-running the prompt stage regenerates this file and discards edits.")
  );
}

/**
 * Every part of the voice, editable against the live agent.
 *
 * The pipeline's voice is a starting point rather than a measurement: gender
 * comes from an analyser's impression of the recording, speed from dividing
 * words-per-minute by a tuning constant, and the voice itself is one UUID
 * picked per language and gender out of a catalogue of hundreds. Whether any of
 * it sounds like the person on the tape is settled by listening, so the loop
 * that matters is change-it, call, change-it - not edit code and re-push.
 *
 * Each control pushes on its own. There is no Save button because there is no
 * moment where a half-set voice is meaningful, and because the thing you do
 * after every change is dial the number again.
 */
function voiceControls(id, d) {
  const live = d.liveVoice;
  const saved = d.voiceOverrides ?? {};
  const isCartesia = live?.provider === "cartesia";

  const note = el("div", { class: "small muted", style: "margin-top:8px" });
  const say = (r, ok) => {
    note.textContent = r?.error
      ? r.error
      : r?.pushed
        ? ok
        : (r?.note ?? "Saved.");
  };

  // Pushed one field at a time so a failure names the setting that caused it.
  const push = async (patch, ok) => {
    note.textContent = "saving…";
    try {
      say(await api(`/api/persona/${id}/voice`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }), ok);
    } catch (e) {
      note.textContent = "Could not save: " + e.message;
    }
  };

  const rows = [];
  const row = (label, hint, ...controls) =>
    rows.push(el("div", { class: "voice-row" },
      el("label", { class: "small" }, label),
      el("div", { class: "row" }, ...controls),
      hint ? el("div", { class: "small muted" }, hint) : null));

  /* ---- which voice (this is where gender lives) ---- */
  const picker = el("select", { class: "select" },
    el("option", { value: "" }, "loading voices…"));
  const genderFilter = el("select", { class: "select" },
    el("option", { value: "" }, "any gender"),
    el("option", { value: "masculine" }, "masculine"),
    el("option", { value: "feminine" }, "feminine"));
  const preview = el("div", { class: "small muted" });

  let catalogue = [];
  const paint = () => {
    const want = genderFilter.value;
    const shown = catalogue.filter((v) => !want || v.gender === want);
    picker.replaceChildren(
      el("option", { value: "" }, `— ${shown.length} voices —`),
      ...shown.map((v) =>
        el("option", { value: v.id, selected: v.id === live?.voiceId },
          `${v.name}${v.gender ? ` (${v.gender})` : ""}`)));
    const cur = catalogue.find((v) => v.id === picker.value);
    preview.textContent = cur?.description ?? "";
  };

  if (isCartesia) {
    api(`/api/cartesia/voices?language=${encodeURIComponent(live?.language ?? "en")}`)
      .then((r) => {
        if (r.error) {
          picker.replaceChildren(el("option", {}, r.error));
          return;
        }
        catalogue = r.voices;
        paint();
      })
      .catch((e) => picker.replaceChildren(el("option", {}, String(e.message))));

    genderFilter.addEventListener("change", paint);
    picker.addEventListener("change", () => {
      const cur = catalogue.find((v) => v.id === picker.value);
      preview.textContent = cur?.description ?? "";
      if (picker.value) push({ voiceId: picker.value }, `Live agent now speaks as ${cur?.name}.`);
    });

    row("Voice", null, genderFilter, picker);
    rows.push(el("div", { class: "voice-row" }, el("span", {}), preview));
  }

  /* ---- speed ---- */
  const range = isCartesia ? { min: 0.6, max: 1.5 } : { min: 0.9, max: 1.3 };
  const curSpeed = saved.speed ?? live?.speed ?? 1;
  const speed = el("input", {
    type: "range", class: "slider", step: "0.01",
    min: String(range.min), max: String(range.max), value: String(curSpeed),
  });
  const speedValue = el("span", { class: "mono" }, `${Number(curSpeed).toFixed(2)}x`);
  speed.addEventListener("input", () => {
    speedValue.textContent = `${Number(speed.value).toFixed(2)}x`;
  });
  // On release, not on drag: each change is an API call to Vapi.
  speed.addEventListener("change", () =>
    push({ speed: Number(speed.value) }, `Live agent now speaks at ${speed.value}x.`));
  row("Speaking rate", isCartesia
    ? "Cartesia generates slower speech rather than stretching finished audio, so it holds up below 0.9x where Azure does not."
    : "0.9x is the floor: below it the voice is stretched rather than slowed, which is what makes it sound synthetic.",
    speed, speedValue);

  if (isCartesia) {
    /* ---- volume ---- */
    const curVol = saved.volume ?? live?.volume ?? 1;
    const vol = el("input", {
      type: "range", class: "slider", step: "0.05", min: "0.5", max: "2",
      value: String(curVol),
    });
    const volValue = el("span", { class: "mono" }, Number(curVol).toFixed(2));
    vol.addEventListener("input", () => {
      volValue.textContent = Number(vol.value).toFixed(2);
    });
    vol.addEventListener("change", () =>
      push({ volume: Number(vol.value) }, `Volume set to ${vol.value}.`));
    row("Volume", null, vol, volValue);

    /* ---- model ---- */
    const model = el("select", { class: "select" });
    row("Model", "Newer Sonic models sound better and cost the same through Vapi; older ones are here for comparison.", model);

    /* ---- language ---- */
    const language = el("select", { class: "select" });
    row("Language", "Hinglish is spoken as Hindi: the Hindi voices read embedded English words natively, which is the whole reason they suit code-mixed speech.", language);

    /* ---- accent localisation ---- */
    const accent = el("select", { class: "select" },
      el("option", { value: "" }, "leave alone"),
      el("option", { value: "0", selected: live?.accentLocalization === 0 }, "keep the voice's native accent"),
      el("option", { value: "1", selected: live?.accentLocalization === 1 }, "pull the accent toward the language"));
    accent.addEventListener("change", () => {
      if (accent.value === "") return;
      push({ accentLocalization: Number(accent.value) }, "Accent handling updated.");
    });
    row("Accent", "Which of these is right is not predictable — localisation can fix an accent or flatten the person. Worth trying both on one call.", accent);

    /* ---- emotion (legacy) ---- */
    const emotion = el("select", { class: "select" });
    row("Emotion", "A Sonic-1 control. Later models accept it and ignore it, so treat it as a no-op unless you are on an older model.", emotion);

    // The option lists come from the server, which reads them from the values
    // Vapi validates against - so the console cannot offer a choice that 400s.
    api("/api/voice-options").then((o) => {
      const fill = (sel, values, current, blank) => {
        sel.replaceChildren(
          el("option", { value: "" }, blank),
          ...values.map((v) =>
            el("option", { value: v, selected: v === current }, v)));
      };
      fill(model, o.models, live?.model, "— model —");
      fill(language, o.languages, live?.language, "— language —");
      fill(emotion, o.emotions, live?.emotion, "none");
      model.addEventListener("change", () =>
        model.value && push({ model: model.value }, `Now using ${model.value}.`));
      language.addEventListener("change", () => {
        if (!language.value) return;
        push({ language: language.value }, `Language set to ${language.value}.`);
        // The catalogue is per language, so the voice list has to follow it.
        api(`/api/cartesia/voices?language=${encodeURIComponent(language.value)}`)
          .then((r) => { catalogue = r.voices ?? []; paint(); });
      });
      emotion.addEventListener("change", () =>
        push({ emotion: emotion.value || null },
          emotion.value ? `Emotion set to ${emotion.value}.` : "Emotion cleared."));
    });
  }

  return el("div", { class: "card" },
    el("h3", {}, "Voice of the live agent"),
    el("div", { class: "small muted", style: "margin-bottom:10px" },
      live
        ? `Live: ${live.provider}${live.model ? ` / ${live.model}` : ""}${live.language ? ` / ${live.language}` : ""}`
        : "The live agent's voice could not be read from Vapi."),
    ...rows,
    note,
    !isCartesia && live ? el("div", { class: "small muted", style: "margin-top:8px" },
      "This agent is on Azure, which exposes only a speaking rate. Set " +
      "VAPI_TTS_PROVIDER=cartesia and re-run vapi:create for the full set.") : null);
}

/**
 * Re-run the vapi stage, which recreates the assistant from files already on
 * disk. Cheap - no transcription, no LLM extraction, just the Vapi call - so it
 * is safe to offer as a button rather than as a warning to go and read the
 * README.
 */
function recreateAgentButton(id) {
  const btn = el("button", { class: "btn small" }, "Recreate agent");
  const out = el("span", { class: "small muted" });
  btn.addEventListener("click", () => {
    btn.disabled = true;
    out.textContent = " recreating…";
    const source = new EventSource(`/api/run/vapi/${encodeURIComponent(id)}`);
    source.addEventListener("done", (e) => {
      source.close();
      const code = JSON.parse(e.data).code;
      out.textContent = code === 0 ? " done — reloading" : ` failed (exit ${code})`;
      if (code === 0) setTimeout(() => route(), 800);
      else btn.disabled = false;
    });
    source.onerror = () => {
      source.close();
      out.textContent = " lost connection to the server";
      btn.disabled = false;
    };
  });
  return el("span", {}, btn, out);
}

/**
 * Dial a real phone from the console.
 *
 * The browser "Talk" button and this are different tests, and the difference is
 * the point. A web call runs on a laptop mic through a wide codec; a phone call
 * is 8kHz narrowband over a carrier, with jitter and packet loss. A persona can
 * sound convincing in the browser and fall apart on the phone - and the phone is
 * the only one a customer will ever hear.
 *
 * Deliberately one number, typed each time, with no saved list: this is a test
 * harness for a persona, not an outbound dialler, and the difference between
 * those two is mostly the presence of a list.
 */
function phoneCall(id, d) {
  const last = d.call;
  const input = el("input", {
    type: "tel",
    placeholder: "+919876543210",
    value: last?.to ?? "",
    class: "tel",
  });
  const status = el("div", { class: "small muted", style: "margin-top:10px" },
    last?.callId ? `Last call: ${last.endedReason ?? last.status ?? "placed"}` : "");
  const btn = el("button", { class: "btn solid" }, "Call");

  let pollTimer = null;
  const poll = (callId) => {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const c = await api(`/api/call/${callId}`);
        if (c.error) return;
        status.textContent =
          `${c.status ?? "…"}${c.endedReason ? ` — ${c.endedReason}` : ""}`;
        // Stop once it is over; nothing after this changes.
        if (c.status === "ended") {
          clearInterval(pollTimer);
          status.textContent =
            `Ended: ${c.endedReason ?? "unknown"}. Latency tab has the breakdown.`;
        }
      } catch {
        clearInterval(pollTimer);
      }
    }, 3000);
  };

  btn.addEventListener("click", async () => {
    const to = input.value.trim();
    if (!to) {
      status.textContent = "Enter a number first.";
      return;
    }
    btn.disabled = true;
    status.textContent = `Dialling ${to}…`;
    try {
      const r = await api(`/api/persona/${id}/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      });
      if (r.error) {
        status.textContent = r.error;
        // The one failure with an obvious next action, so offer it rather than
        // making someone go and find the right CLI stage.
        if (r.needsAgent) status.append(" ", recreateAgentButton(id));
      } else {
        status.textContent = `Ringing ${r.to}…`;
        poll(r.callId);
      }
    } catch (e) {
      status.textContent = "Could not place the call: " + e.message;
    } finally {
      btn.disabled = false;
    }
  });

  if (state.config.hasPhoneNumber === false) {
    return el("div", { class: "card" },
      el("h3", {}, "Call a phone"),
      el("div", { class: "muted" },
        "VAPI_PHONE_NUMBER_ID is not set on the server, so there is no number " +
        "to dial out from."));
  }

  return el("div", { class: "card" },
    el("h3", {}, "Call a phone"),
    el("div", { class: "small muted", style: "margin-bottom:10px" },
      "The agent dials out and speaks to whoever answers. This is the test that " +
      "counts: narrowband audio over a carrier is what a customer actually hears, " +
      "and it is harsher than the browser."),
    el("div", { class: "row" }, input, btn),
    el("div", { class: "small muted", style: "margin-top:8px" },
      "Full international format, including country code."),
    status);
}

/**
 * Where the time goes on a call.
 *
 * "It reacts late" is four different bugs wearing the same coat - a slow
 * transcriber, endpointing that waits out silence which already ended, a model
 * that thinks before answering, or a voice slow to make sound. Each is fixed in
 * a different place, so the useful number is never the total: it is which
 * component owns the total.
 *
 * Hence the bar. Four segments, drawn to scale, and the largest one is the one
 * to go and fix. A column of five numbers makes you do that comparison in your
 * head on every row; a bar has already done it.
 */
const LAYERS = [
  { key: "transcriber", label: "Transcriber", hint: "speech to words" },
  { key: "endpointing", label: "Endpointing", hint: "deciding you had finished" },
  { key: "model", label: "Model", hint: "thinking, to first token" },
  { key: "voice", label: "Voice", hint: "words to sound" },
];

const ms = (n) => (n === null || n === undefined ? "—" : `${Math.round(n)}ms`);

function latencyBar(parts) {
  const total = LAYERS.reduce((sum, l) => sum + (parts[l.key] ?? 0), 0);
  if (!total) return el("div", { class: "small muted" }, "no breakdown recorded");
  return el("div", { class: "lat-bar" },
    ...LAYERS.map((l, i) =>
      el("div", {
        class: `lat-seg s${i}`,
        style: `width:${((parts[l.key] ?? 0) / total) * 100}%`,
        title: `${l.label}: ${ms(parts[l.key])}`,
      })));
}

function latencyPanel(id, d) {
  const card = el("div", { class: "card" },
    el("h3", {}, "Latency"),
    el("div", { class: "small muted" }, "loading…"));

  const legend = el("div", { class: "lat-legend" },
    ...LAYERS.map((l, i) =>
      el("span", { class: "lat-key" },
        el("i", { class: `lat-dot s${i}` }),
        `${l.label} — ${l.hint}`)));

  api(`/api/persona/${id}/latency`).then((r) => {
    if (r.error) {
      mount(card, el("h3", {}, "Latency"), el("div", { class: "muted" }, r.error));
      return;
    }
    if (!r.calls?.length) {
      mount(card,
        el("h3", {}, "Latency"),
        el("div", { class: "muted" },
          r.note ??
          (r.emptyCalls
            ? `${r.emptyCalls} recent call${r.emptyCalls > 1 ? "s" : ""} had no back-and-forth, ` +
              "so there is nothing to measure. Make a call and answer the agent."
            : "No calls recorded yet.")));
      card.append(legend);
      return;
    }

    const kids = [
      el("h3", {}, "Latency"),
      el("div", { class: "small muted", style: "margin-bottom:14px" },
        "Measured by Vapi on each turn. The segments are drawn to scale, so the " +
        "widest one is the layer worth fixing."),
      legend,
    ];

    for (const c of r.calls) {
      const when = c.startedAt ? new Date(c.startedAt).toLocaleString() : "unknown time";
      kids.push(el("div", { class: "lat-call" },
        el("div", { class: "lat-head" },
          el("b", {}, ms(c.averages.total)),
          el("span", { class: "small muted" },
            ` average over ${c.turns} turn${c.turns > 1 ? "s" : ""} · ${when}`)),
        latencyBar(c.averages),
        el("div", { class: "lat-nums" },
          ...LAYERS.map((l) =>
            el("span", { class: "small" },
              el("span", { class: "muted" }, `${l.label} `),
              el("span", { class: "mono" }, ms(c.averages[l.key]))))),
        c.interruptions.assistant
          ? el("div", { class: "small muted", style: "margin-top:6px" },
              `Agent interrupted the caller ${c.interruptions.assistant} time(s) — ` +
              "if that is climbing, the endpointing wait is too short.")
          : null,
        // Per-turn rows, because an average hides the one 4-second turn that is
        // what the caller actually remembers.
        el("details", { class: "lat-turns" },
          el("summary", { class: "small muted" }, `each turn (${c.turns})`),
          el("table", { class: "lat-table" },
            el("tr", {},
              el("th", {}, "#"),
              ...LAYERS.map((l) => el("th", {}, l.label)),
              el("th", {}, "total")),
            ...c.turnLatencies.map((t, i) =>
              el("tr", {},
                el("td", { class: "muted" }, String(i + 1)),
                ...LAYERS.map((l) => el("td", { class: "mono" }, ms(t[l.key]))),
                el("td", { class: "mono" }, ms(t.total))))))));
    }
    mount(card, ...kids);
  }).catch((e) => {
    mount(card, el("h3", {}, "Latency"), el("div", { class: "muted" }, String(e.message)));
  });

  return card;
}

const tr = (k, v) => el("tr", {}, el("td", {}, k), el("td", {}, String(v ?? "-")));
const chip = (t) => el("span", { class: "chip" }, t);

/* ---------------- routing ---------------- */

function route() {
  const hash = location.hash || "#/";
  store.lastRoute = hash;

  // Leaving the talk screen must tear the call down, or audio keeps playing
  // over the persona list.
  if (!hash.startsWith("#/talk/")) {
    if (state.call) state.vapi?.stop();
    state.blob?.stop();
    state.blob = null;
  }

  const talk = hash.match(/^#\/talk\/(.+)$/);
  // The trailing segment is the tab. Optional, so old links still work.
  const detail = hash.match(/^#\/detail\/([^/]+)(?:\/([a-z]+))?$/);

  if (hash === "#/" || hash === "") return screenLanding();
  if (hash === "#/personas") return screenList();
  if (hash === "#/new") return screenNew();
  if (talk) return screenTalk(decodeURIComponent(talk[1]));
  if (detail) return screenDetail(decodeURIComponent(detail[1]), detail[2] ?? "tune");
  return screenLanding();
}

document.getElementById("home").onclick = () => go("#/");

document.getElementById("theme").onclick = () => {
  store.theme = store.theme === "dark" ? "light" : "dark";
};

window.addEventListener("hashchange", route);

(async () => {
  state.config = await api("/api/config");
  if (!location.hash) location.hash = store.lastRoute;
  route();
})();
