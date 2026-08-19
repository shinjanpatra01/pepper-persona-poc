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

const state = { config: {}, personas: [], vapi: null, blob: null, call: null };

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
                    ? [p.role, p.tone, p.accent].filter(Boolean).join(" · ")
                    : "not processed yet")
              ),
              el("div", { class: "state" }, p.ready ? "Talk →" : "Incomplete"),
              el("button", {
                class: "btn ghost small",
                title: "Delete",
                onclick: (e) => { e.stopPropagation(); removePersona(p); },
              }, "✕")
            )
          ))
  );
}

async function removePersona(p) {
  if (!confirm(`Delete "${p.name}" and all its artifacts?`)) return;
  await fetch(`/api/persona/${p.id}`, { method: "DELETE" });
  screenList();
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
      el("button", { class: "btn ghost", onclick: () => go("#/") }, "Cancel")
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
        el("button", { class: "btn", onclick: () => go("#/") }, "All personas")));
    } else {
      append(`\nPipeline stopped (exit ${code}). The artifacts produced so far are kept.\n`);
      stepsBox.append(el("div", { class: "row", style: "margin-top:16px" },
        el("button", { class: "btn", onclick: () => go(`#/detail/${id}`) }, "Inspect what was built"),
        el("button", { class: "btn ghost", onclick: () => go("#/") }, "Back")));
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
  const backBtn = el("button", { class: "btn ghost", onclick: () => go("#/") }, "Back");
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

  button.disabled = true;
  status.textContent = "connecting…";
  blob.setState("connecting");

  try {
    if (!state.vapi) {
      const { default: Vapi } = await import("https://esm.sh/@vapi-ai/web@2");
      state.vapi = new Vapi(state.config.vapiPublicKey);

      state.vapi.on("call-start", () => {
        state.call = true;
        button.disabled = false;
        button.textContent = "End call";
        status.textContent = "listening";
        blob.setState("listening");
      });

      state.vapi.on("call-end", () => {
        state.call = null;
        button.disabled = false;
        button.textContent = "Start call";
        status.textContent = "call ended";
        blob.setState("idle");
        blob.setLevel(0);
      });

      // The blob is driven by real output loudness rather than a canned
      // animation, so silence looks like silence.
      state.vapi.on("volume-level", (v) => blob.setLevel(v));

      state.vapi.on("speech-start", () => {
        blob.setState("speaking");
        status.textContent = "speaking";
      });
      state.vapi.on("speech-end", () => {
        blob.setState("listening");
        status.textContent = "listening";
        blob.setLevel(0);
      });

      state.vapi.on("message", (m) => {
        if (m.type === "transcript" && m.transcriptType === "final") {
          caption.replaceChildren(
            el("span", { class: "who" }, m.role === "assistant" ? "agent" : "you"),
            document.createTextNode(m.transcript)
          );
        }
      });

      state.vapi.on("error", (e) => {
        state.call = null;
        button.disabled = false;
        button.textContent = "Start call";
        blob.setState("idle");
        status.textContent = "error: " + (e?.errorMsg || e?.message || JSON.stringify(e));
      });
    }

    await state.vapi.start(assistantId);
  } catch (error) {
    button.disabled = false;
    blob.setState("idle");
    status.textContent = "could not start: " + error.message;
  }
}

/* ---------------- screen: detail ---------------- */

async function screenDetail(id) {
  const d = await api(`/api/persona/${id}`);
  const name = d.meta?.name ?? id;
  setCrumb(name);
  const s = d.spec;

  mount(app(),
    el("div", { class: "title-row" },
      el("h1", {}, name),
      el("div", { class: "row" },
        d.assistant?.assistantId
          ? el("button", { class: "btn solid", onclick: () => go(`#/talk/${id}`) }, "Talk")
          : null,
        el("button", { class: "btn ghost", onclick: () => go("#/") }, "Back"))
    ),

    el("div", { class: "card" },
      el("h3", {}, "Recording"),
      el("audio", { controls: true, preload: "metadata", src: `/api/audio/${id}` })
    ),

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
    ) : el("div", { class: "card" }, el("h3", {}, "Persona"), el("div", { class: "muted" }, "Not extracted yet.")),

    s?.voice_profile ? el("div", { class: "card" },
      el("h3", {}, "Voice"),
      el("table", {},
        tr("accent", `${s.voice_profile.accent} (${s.voice_profile.accent_code})`),
        tr("gender", s.voice_profile.perceived_gender),
        tr("pace", s.voice_profile.perceived_pace),
        tr("register", s.voice_profile.emotional_register),
        d.transcript?.prosody?.agent
          ? tr("measured rate", `${d.transcript.prosody.agent.words_per_minute} words/min`)
          : null)
    ) : null,

    s?.evidence?.signature_phrases?.length ? el("div", { class: "card" },
      el("h3", {}, "Signature phrases (verbatim from the recording)"),
      ...s.evidence.signature_phrases.map((p) => el("div", { class: "chip" }, `"${p}"`))
    ) : null,

    d.systemPrompt ? el("div", { class: "card" },
      el("h3", {}, "System prompt"),
      d.firstMessage ? el("div", { class: "small muted", style: "margin-bottom:10px" },
        `Opens with: "${d.firstMessage}"`) : null,
      el("pre", { class: "prompt" }, d.systemPrompt)
    ) : null,

    d.transcript ? el("div", { class: "card" },
      el("h3", {}, `Transcript — ${d.transcript.turns.length} turns`),
      ...d.transcript.turns.map((t) =>
        el("div", { class: `turn ${t.speaker}` },
          el("div", { class: "who" }, t.speaker),
          el("div", { class: "txt" }, t.text)))
    ) : null
  );
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
  const detail = hash.match(/^#\/detail\/(.+)$/);

  if (hash === "#/new") return screenNew();
  if (talk) return screenTalk(decodeURIComponent(talk[1]));
  if (detail) return screenDetail(decodeURIComponent(detail[1]));
  return screenList();
}

document.getElementById("theme").onclick = () => {
  store.theme = store.theme === "dark" ? "light" : "dark";
};

window.addEventListener("hashchange", route);

(async () => {
  state.config = await api("/api/config");
  if (!location.hash) location.hash = store.lastRoute;
  route();
})();
