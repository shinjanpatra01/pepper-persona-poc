import { detectAudioLanguage } from "../audio/detectLanguage.js";
import { lookupLanguage } from "../audio/languages.js";
import { flagString, parseArgs } from "../lib/args.js";
import { hasSarvam } from "../transcription/sarvam.js";
import { selectTranscriber } from "../vapi/languageRouting.js";

/**
 * Run the detection layer on its own, without transcribing.
 *
 * This exists so the routing decision can be checked and argued with before it
 * costs a full pipeline run. It prints every signal, not just the verdict,
 * which is what makes a wrong answer diagnosable rather than merely annoying.
 *
 *   npm run detect -- examples/recording-3/audio.mp3
 */
const USAGE = `
Usage:
  npm run detect -- <audio-file>

Options:
  --llm    Always run the multimodal audio probe, even when the cheap
           signals already agree. Slower; the only detector that hears
           accent rather than words.
`.trim();

async function main() {
  const { positionals, flags } = parseArgs();
  const source = positionals[0];

  if (!source || flags.help) {
    console.log(USAGE);
    process.exit(source ? 0 : 1);
  }

  if (!hasSarvam()) {
    console.log(
      "! SARVAM_API_KEY is not set. Indian-language identification is " +
        "unavailable, so this run uses Deepgram and text signals only.\n"
    );
  }

  const profile = await detectAudioLanguage({
    audioPath: source,
    forceLanguage: flagString(flags, "language"),
    alwaysUseLlm: flags.llm === true,
  });

  console.log(`Language   : ${profile.label} (${profile.language})`);
  console.log(`Script     : ${profile.script}`);
  console.log(`Indian     : ${profile.is_indian ? "yes" : "no"}`);
  console.log(`Code-mixed : ${profile.code_mixed ? "yes" : "no"}`);
  console.log(`Confidence : ${profile.confidence} - ${profile.detected_by}`);

  console.log("\nSignals");
  console.log("-------");
  for (const signal of profile.signals) {
    console.log(`  [${signal.source}] ${signal.language ?? "-"} ` +
      `(${signal.confidence.toFixed(2)})\n      ${signal.detail}`);
  }

  if (profile.notes.length) {
    console.log("\nNotes");
    console.log("-----");
    for (const note of profile.notes) console.log(`  ! ${note}`);
  }

  const row = lookupLanguage(profile.language)!;
  const transcriber = selectTranscriber(profile);

  console.log("\nRouting");
  console.log("-------");
  console.log(
    `  offline STT : ${
      row.indian && row.code !== "en-IN"
        ? `sarvam saaras (${row.sarvam}) over Deepgram diarisation`
        : `deepgram (${row.deepgram})`
    }`
  );
  console.log(`  live STT    : ${JSON.stringify(transcriber.config)}`);
  console.log(`  TTS locale  : ${row.azureLocale} ` +
    `(${row.azureVoices.female} / ${row.azureVoices.male})`);
  for (const reason of transcriber.rationale) console.log(`  - ${reason}`);
}

main().catch((error) => {
  console.error(`\nDetection failed: ${(error as Error).message}`);
  process.exit(1);
});
