import { join } from "node:path";
import { flagString, parseArgs } from "../lib/args.js";
import { readJson, writeJson } from "../lib/io.js";
import { describeAudioLlm } from "../lib/llm.js";
import { analyzeVoice } from "../persona/analyzeVoice.js";
import { StoredAgentSpecSchema, TranscriptSchema } from "../types.js";
import { selectVoice } from "../vapi/voiceMapping.js";

/**
 * Optional audio pass (PRD 5, "Optional experiment").
 *
 *   npm run analyze-voice -- examples/recording-1
 *
 * Kept as its own command on purpose: the whole point of the experiment is to
 * be able to compare a spec WITH the audio layer against the same spec
 * without it, so adding the layer must be a separate, reversible action.
 */
const USAGE = `
Usage:
  npm run analyze-voice -- <examples/recording-N> [--audio=<path>]

Reads transcript.json (for the agent's speech timings) and the audio file,
then adds a voice_profile to agent-spec.json.
`.trim();

async function main() {
  const { positionals, flags } = parseArgs();
  const dir = positionals[0];

  if (!dir || flags.help) {
    console.log(USAGE);
    process.exit(dir ? 0 : 1);
  }

  const transcript = await readJson(join(dir, "transcript.json"), TranscriptSchema);
  const specPath = join(dir, "agent-spec.json");
  const spec = await readJson(specPath, StoredAgentSpecSchema);

  const prosody = transcript.prosody?.agent;
  if (!prosody || prosody.segments.length === 0) {
    throw new Error(
      "This transcript has no prosody data. It predates the audio feature or " +
        "was hand-written. Re-run: npm run transcribe -- " +
        `${join(dir, "audio.mp3")} --repair`
    );
  }

  const audioPath = flagString(flags, "audio") ?? join(dir, "audio.mp3");

  console.log("Measured from the audio");
  console.log("-----------------------");
  console.log(`  speaking rate      : ${prosody.words_per_minute} words/min`);
  console.log(`  talk ratio         : ${(prosody.talk_ratio * 100).toFixed(0)}% of the call`);
  console.log(`  mean word gap      : ${prosody.mean_intra_turn_pause}s`);
  console.log(`  deliberate pauses  : ${prosody.long_pauses_per_100_words} per 100 words`);
  console.log(`  reply latency      : ${prosody.mean_response_latency}s`);
  console.log(`  usable segments    : ${prosody.segments.length}`);

  console.log(`\nListening to the agent's voice with ${describeAudioLlm()}...`);
  const profile = await analyzeVoice({ audioPath, prosody });

  console.log("\nVoice profile");
  console.log("-------------");
  console.log(`  gender     : ${profile.perceived_gender}`);
  console.log(`  accent     : ${profile.accent} (${profile.accent_code})`);
  console.log(`  pitch      : ${profile.pitch}`);
  console.log(`  timbre     : ${profile.timbre}`);
  console.log(`  pace       : ${profile.perceived_pace}`);
  console.log(`  register   : ${profile.emotional_register}`);
  console.log(`  pauses     : ${profile.pause_style}`);
  console.log(`  confidence : ${profile.confidence}`);

  console.log("\nDelivery notes");
  for (const note of profile.delivery_notes) console.log(`  - ${note}`);

  // This is the actual finding of the optional experiment.
  console.log("\nAudible only in the audio (not derivable from the transcript)");
  for (const item of profile.audio_only_observations) console.log(`  - ${item}`);

  const selection = selectVoice(profile, prosody);
  console.log("\nSelected Vapi voice");
  console.log("-------------------");
  console.log(`  ${selection.provider} / ${selection.voiceId} @ ${selection.speed}x`);
  for (const reason of selection.rationale) console.log(`  - ${reason}`);

  await writeJson(specPath, { ...spec, voice_profile: profile });
  console.log(`\nUpdated ${specPath} with voice_profile.`);
  console.log(`Next: npm run vapi:create -- ${dir}`);
}

main().catch((error) => {
  console.error(`\nanalyze-voice failed: ${(error as Error).message}`);
  process.exit(1);
});
