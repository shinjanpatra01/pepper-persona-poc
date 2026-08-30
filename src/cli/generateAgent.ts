import { dirname, join } from "node:path";
import { flagNumber, flagString, parseArgs } from "../lib/args.js";
import { readJson, writeJson, writeText } from "../lib/io.js";
import { describeLlm } from "../lib/llm.js";
import { generateAgentSpec } from "../persona/generateAgentSpec.js";
import { generatePrompt } from "../persona/generatePrompt.js";
import { repairSpeakers } from "../transcription/repairSpeakers.js";
import { buildTranscript } from "../transcription/transcribe.js";
import { TranscriptSchema } from "../types.js";

/**
 * The end-to-end command from PRD 4.4:
 *
 *   npm run generate-agent -- examples/recording-1/audio.mp3
 *
 * It runs transcription -> persona analysis -> prompt generation and writes
 * every intermediate artifact, because the intermediates are the point of this
 * POC (PRD 2). It deliberately stops before Vapi: creating the assistant and
 * placing a call are separate scripts, so that rerunning the analysis never
 * silently mutates a live assistant or dials a phone.
 */
const USAGE = `
Usage:
  npm run generate-agent -- <audio-file-or-media-url> [options]

Options:
  --out=<dir>          Where artifacts go. Defaults to the audio file's folder.
  --agent=<n>          Force which Deepgram speaker number is the agent.
  --no-repair          Skip the LLM speaker-label repair pass (on by default
                       here, since an unattended run cannot eyeball a preview).
  --notes="..."        Provenance note (PRD 3.1).
  --from-transcript    Reuse an existing transcript.json in the output folder
                       instead of calling Deepgram again. Useful when you have
                       hand-corrected the speakers.
`.trim();

async function main() {
  const { positionals, flags } = parseArgs();
  const source = positionals[0];

  if (!source || flags.help) {
    console.log(USAGE);
    process.exit(source ? 0 : 1);
  }

  const isUrl = /^https?:\/\//i.test(source);
  const outDir = flagString(flags, "out") ?? (isUrl ? undefined : dirname(source));
  if (!outDir) {
    console.error("A URL source requires --out=<dir>.\n");
    console.error(USAGE);
    process.exit(1);
  }

  const transcriptPath = join(outDir, "transcript.json");
  const specPath = join(outDir, "agent-spec.json");
  const promptPath = join(outDir, "system-prompt.txt");
  const firstPath = join(outDir, "first-message.txt");
  const idlePath = join(outDir, "idle-messages.json");

  /* -------- Stage 1: transcript -------- */
  let transcript;

  if (flags["from-transcript"]) {
    console.log(`[1/3] Reusing ${transcriptPath}`);
    transcript = await readJson(transcriptPath, TranscriptSchema);
  } else {
    console.log(`[1/3] Transcribing ${source} with Deepgram...`);
    const built = await buildTranscript({
      source,
      notes: flagString(flags, "notes"),
      agentSpeaker: flagNumber(flags, "agent"),
    });
    transcript = built.transcript;

    for (const reason of built.decision.reasons) console.log(`      ${reason}`);

    if (!flags["no-repair"]) {
      const repair = await repairSpeakers(transcript);
      console.log(`      ${repair.note}`);
      transcript = repair.transcript;
    }

    await writeJson(transcriptPath, transcript);
    console.log(`      -> ${transcriptPath} (${transcript.turns.length} turns)`);
  }

  /* -------- Stage 2: agent spec -------- */
  console.log(`[2/3] Extracting persona with ${describeLlm()}...`);
  const { spec, stats, warnings: specWarnings } = await generateAgentSpec(transcript);
  await writeJson(specPath, spec);
  console.log(
    `      ${spec.role} | ${spec.tone.style} | ` +
      `aggressiveness=${spec.objection_handling.aggressiveness} | ` +
      `${stats.avgWordsPerAgentTurn} words/turn`
  );
  console.log(`      -> ${specPath}`);

  /* -------- Stage 3: system prompt -------- */
  console.log("[3/3] Generating the system prompt...");
  const { systemPrompt, firstMessage, idleMessages, warnings: promptWarnings } =
    await generatePrompt(spec);
  await writeText(promptPath, systemPrompt + "\n");
  await writeText(firstPath, firstMessage + "\n");
  await writeJson(idlePath, idleMessages);
  console.log(`      first message: "${firstMessage}"`);
  console.log(`      -> ${promptPath}`);
  console.log(`      -> ${firstPath}`);
  console.log(`      -> ${idlePath}`);

  const allWarnings = [...specWarnings, ...promptWarnings];
  if (allWarnings.length > 0) {
    console.log("\nWarnings");
    console.log("--------");
    for (const warning of allWarnings) console.log(`  ! ${warning}`);
  }

  console.log("\nDone. Next: npm run vapi:create -- " + specPath);
}

main().catch((error) => {
  console.error(`\ngenerate-agent failed: ${(error as Error).message}`);
  process.exit(1);
});
