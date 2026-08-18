import { dirname, join } from "node:path";
import { flagNumber, flagString, parseArgs } from "../lib/args.js";
import { writeJson } from "../lib/io.js";
import { repairSpeakers } from "../transcription/repairSpeakers.js";
import { buildTranscript } from "../transcription/transcribe.js";

/**
 * Stage 1 of the pipeline (PRD 2, "Transcriber").
 *
 *   npm run transcribe -- examples/recording-1/audio.mp3
 *   npm run transcribe -- https://example.com/call.mp3 --out=examples/recording-2
 *   npm run transcribe -- examples/recording-1/audio.mp3 --agent=1   # override
 */
const USAGE = `
Usage:
  npm run transcribe -- <audio-file-or-media-url> [options]

Options:
  --out=<dir>     Directory to write transcript.json into.
                  Defaults to the folder containing the audio file.
  --agent=<n>     Force which Deepgram speaker number is the agent,
                  bypassing the heuristic (see the printed decision).
  --notes="..."   Provenance note stored in the transcript (PRD 3.1).
  --repair        Run an LLM pass over the diarised text to fix speaker
                  labels using conversational logic. Recommended whenever
                  the two voices are acoustically similar. The repair is
                  verified word-for-word and rejected if any word changed.
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
    console.error("A URL source requires --out=<dir> so we know where to write.\n");
    console.error(USAGE);
    process.exit(1);
  }

  console.log(`Transcribing ${source} with Deepgram (diarisation on)...`);

  const built = await buildTranscript({
    source,
    notes: flagString(flags, "notes"),
    agentSpeaker: flagNumber(flags, "agent"),
  });
  const { decision, overridden } = built;
  let transcript = built.transcript;

  // Show the reasoning. PRD 3.2 allows manual correction, and the operator can
  // only correct what they can see.
  console.log("\nSpeaker assignment");
  console.log("------------------");
  for (const reason of decision.reasons) console.log(`  - ${reason}`);
  if (overridden) {
    console.log(`  ! Heuristic overridden by --agent=${flagNumber(flags, "agent")}.`);
  } else if (decision.confidence === "low") {
    console.log(
      "  ! LOW CONFIDENCE. Read the preview below; if the roles look swapped, " +
        "rerun with --agent=<the other number>."
    );
  }

  if (flags.repair) {
    console.log("\nRepairing speaker labels with the LLM...");
    const repair = await repairSpeakers(transcript);
    console.log(`  ${repair.note}`);
    transcript = repair.transcript;
  }

  const outPath = join(outDir, "transcript.json");
  await writeJson(outPath, transcript);

  console.log(`\nPreview (first 6 of ${transcript.turns.length} turns)`);
  console.log("------------------");
  for (const turn of transcript.turns.slice(0, 6)) {
    const text = turn.text.length > 110 ? `${turn.text.slice(0, 110)}...` : turn.text;
    console.log(`  ${turn.speaker.padEnd(8)} | ${text}`);
  }

  console.log(`\nWrote ${outPath}`);
}

main().catch((error) => {
  console.error(`\nTranscription failed: ${(error as Error).message}`);
  process.exit(1);
});
