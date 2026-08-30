import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { parseArgs } from "../lib/args.js";
import { readJson, writeJson } from "../lib/io.js";
import { StoredAgentSpecSchema, TranscriptSchema } from "../types.js";
import { createOrUpdateAgent } from "../vapi/createAgent.js";
import {
  languageInstructions,
  selectTranscriber,
} from "../vapi/languageRouting.js";
import { selectVoice, voiceDeliveryInstructions } from "../vapi/voiceMapping.js";
import { VoiceOverridesSchema } from "../vapi/voiceOverrides.js";

/**
 * Stage 4 of the pipeline (PRD 2, "Vapi Adapter").
 *
 *   npm run vapi:create -- examples/recording-1
 *
 * Takes a recording FOLDER rather than a single file, because creating the
 * assistant needs three artifacts at once: the spec, the prompt and the
 * opening line. The returned assistant ID is written back into the folder so
 * every experiment is traceable (PRD 4.2).
 */
const USAGE = `
Usage:
  npm run vapi:create -- <examples/recording-N>

Reads agent-spec.json, system-prompt.txt and first-message.txt from the folder.
Writes vapi-assistant.json containing the assistant ID.
Re-running updates the same assistant instead of creating a duplicate.
`.trim();

const AssistantRecordSchema = z.object({
  assistantId: z.string(),
  name: z.string(),
  systemPromptWords: z.number(),
  updatedAt: z.string(),
});

async function main() {
  const { positionals, flags } = parseArgs();
  const dir = positionals[0];

  if (!dir || flags.help) {
    console.log(USAGE);
    process.exit(dir ? 0 : 1);
  }

  const spec = await readJson(join(dir, "agent-spec.json"), StoredAgentSpecSchema);
  let systemPrompt = (await readFile(join(dir, "system-prompt.txt"), "utf8")).trim();
  const firstMessage = (await readFile(join(dir, "first-message.txt"), "utf8")).trim();

  // Written by the prompt stage. Missing on personas generated before the
  // silence handling existed, in which case Vapi keeps its own behaviour and
  // the operator is told to re-run the stage.
  const idleMessages =
    (await readJson(join(dir, "idle-messages.json"), z.array(z.string())).catch(
      () => null
    )) ?? undefined;

  const recordPath = join(dir, "vapi-assistant.json");
  let existingAssistantId: string | undefined;
  try {
    existingAssistantId = (await readJson(recordPath, AssistantRecordSchema)).assistantId;
  } catch {
    // No prior assistant for this recording; we will create one.
  }

  // If the optional audio pass has run, the voice profile shapes the assistant
  // twice: it picks the TTS voice, and it adds a delivery section to the prompt
  // for the things TTS cannot control (phrasing, rhythm, register).
  const transcript = await readJson(join(dir, "transcript.json"), TranscriptSchema);

  // The language the recording was detected as drives three things at once:
  // the STT the agent listens with, the TTS locale it answers in, and the
  // language rules in its prompt. Missing on transcripts made before the
  // detection layer existed, in which case everything below is a no-op and the
  // agent keeps Vapi's English defaults.
  let transcriber;
  const detected = transcript.language;
  if (detected) {
    console.log(
      `Recording language: ${detected.label} (${detected.language}), ` +
        `${detected.confidence} confidence` +
        (detected.code_mixed ? ", code-mixed with English" : "")
    );
    if (detected.language !== "en") {
      transcriber = selectTranscriber(detected);
      for (const reason of transcriber.rationale) console.log(`  - ${reason}`);

      const instructions = languageInstructions(detected);
      if (instructions) systemPrompt += "\n\n# Language\n" + instructions;
    } else {
      console.log("  - English; leaving Vapi's default transcriber in place.");
    }
  } else {
    console.log(
      "No language profile in the transcript (made before the detection layer). " +
        "Re-run the transcribe stage to route STT and TTS by language."
    );
  }

  let voice;
  let voiceOverrides;
  if (spec.voice_profile) {
    const prosody = transcript.prosody?.agent;
    if (prosody) {
      voice = selectVoice(spec.voice_profile, prosody, detected);

      /*
       * Console edits win over the derived voice.
       *
       * The derivation is a starting point, not a fact: the speed divides
       * words-per-minute by a tuning constant, and the voice itself is one
       * UUID picked per language and gender out of a catalogue of hundreds.
       * Someone who listened to a call and changed it knows more than the
       * arithmetic does, and having a re-push silently revert that is how a
       * tuning knob becomes useless.
       */
      voiceOverrides =
        (await readJson(join(dir, "voice-overrides.json"), VoiceOverridesSchema).catch(
          () => null
        )) ?? undefined;
      if (voiceOverrides && Object.keys(voiceOverrides).length) {
        console.log(
          `  - Console overrides applied: ${Object.entries(voiceOverrides)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}`
        );
      }
      systemPrompt +=
        "\n\n# Delivery\n" + voiceDeliveryInstructions(spec.voice_profile, prosody);
      console.log(
        `Voice profile found: ${voice.provider}/${voice.voiceId} @ ${voice.speed}x`
      );
      for (const reason of voice.rationale) console.log(`  - ${reason}`);
    }
  } else {
    console.log("No voice_profile in the spec; leaving the Vapi default voice.");
  }

  // Prefer the persona's display name over the folder name, so pushing an
  // update does not silently undo a rename.
  const meta = await readJson(
    join(dir, "persona.json"),
    z.object({ name: z.string() }).loose()
  ).catch(() => null);
  const label = meta?.name ?? basename(resolve(dir));
  console.log(
    existingAssistantId
      ? `Updating Vapi assistant ${existingAssistantId}...`
      : `Creating a new Vapi assistant for ${label}...`
  );

  const { assistant, created } = await createOrUpdateAgent({
    spec,
    systemPrompt,
    firstMessage,
    label,
    existingAssistantId,
    idleMessages,
    voice,
    voiceOverrides,
    transcriber,
  });

  await writeJson(recordPath, {
    assistantId: assistant.id,
    name: assistant.name,
    systemPromptWords: systemPrompt.split(/\s+/).filter(Boolean).length,
    updatedAt: assistant.updatedAt,
  });

  console.log(`\n${created ? "Created" : "Updated"} "${assistant.name}"`);
  console.log(`  assistant id : ${assistant.id}`);
  console.log(`  first message: "${firstMessage}"`);
  if (idleMessages) {
    console.log(`  idle lines   : ${idleMessages.map((m) => `"${m}"`).join(", ")}`);
  } else {
    console.log(
      "  idle lines   : none (re-run the prompt stage to generate them; " +
        "without them the agent has nothing of its own to say into a silence)"
    );
  }
  console.log(`  -> ${recordPath}`);
  console.log(
    `\nTest it in the browser: https://dashboard.vapi.ai/assistants/${assistant.id}` +
      `\nor place a phone call once a number is connected:` +
      `\n  npm run vapi:call -- ${dir}`
  );
}

main().catch((error) => {
  console.error(`\nvapi:create failed: ${(error as Error).message}`);
  process.exit(1);
});
