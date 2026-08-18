import { dirname, join } from "node:path";
import { flagString, parseArgs } from "../lib/args.js";
import { readJson, writeJson } from "../lib/io.js";
import { describeLlm } from "../lib/llm.js";
import { generateAgentSpec } from "../persona/generateAgentSpec.js";
import { TranscriptSchema } from "../types.js";

/**
 * Stage 2 of the pipeline (PRD 2, "Persona Analyzer").
 *
 *   npm run analyze -- examples/recording-1/transcript.json
 */
const USAGE = `
Usage:
  npm run analyze -- <path/to/transcript.json> [--out=<dir>]

Writes agent-spec.json next to the transcript unless --out is given.
`.trim();

async function main() {
  const { positionals, flags } = parseArgs();
  const transcriptPath = positionals[0];

  if (!transcriptPath || flags.help) {
    console.log(USAGE);
    process.exit(transcriptPath ? 0 : 1);
  }

  // Validated on read: a hand-edited transcript with a bad speaker label fails
  // here with a precise message rather than silently skewing the persona.
  const transcript = await readJson(transcriptPath, TranscriptSchema);

  console.log(`Analysing ${transcript.turns.length} turns using ${describeLlm()}...`);

  const { spec, stats, warnings } = await generateAgentSpec(transcript);

  const outDir = flagString(flags, "out") ?? dirname(transcriptPath);
  const outPath = join(outDir, "agent-spec.json");
  await writeJson(outPath, spec);

  console.log("\nMeasured from the transcript");
  console.log("----------------------------");
  console.log(`  agent turns        : ${stats.agentTurns}`);
  console.log(`  customer turns     : ${stats.customerTurns}`);
  console.log(`  avg words per turn : ${stats.avgWordsPerAgentTurn}`);
  console.log(`  agent questions    : ${stats.agentQuestions}`);

  // A compact fingerprint of the persona. Run this for two recordings and the
  // difference should be visible at a glance - that is PRD 8's requirement
  // that specs be "meaningfully different" for different source personas.
  console.log("\nExtracted persona fingerprint");
  console.log("-----------------------------");
  console.log(`  role            : ${spec.role}`);
  console.log(`  objective       : ${spec.objective}`);
  console.log(
    `  tone            : ${spec.tone.style}, formality=${spec.tone.formality}, ` +
      `energy=${spec.tone.energy}, warmth=${spec.tone.warmth}`
  );
  console.log(
    `  objections      : aggressiveness=${spec.objection_handling.aggressiveness}, ` +
      `persistence=${spec.objection_handling.persistence}`
  );
  console.log(
    `  response length : ${spec.speaking_style.response_length} ` +
      `(one question at a time: ${spec.speaking_style.one_question_at_a_time})`
  );
  console.log(`  confidence      : ${spec.evidence.confidence}`);
  console.log("  signature phrases:");
  for (const phrase of spec.evidence.signature_phrases.slice(0, 5)) {
    console.log(`      "${phrase}"`);
  }

  if (warnings.length > 0) {
    console.log("\nWarnings");
    console.log("--------");
    for (const warning of warnings) console.log(`  ! ${warning}`);
  }

  console.log(`\nWrote ${outPath}`);
}

main().catch((error) => {
  console.error(`\nAnalysis failed: ${(error as Error).message}`);
  process.exit(1);
});
