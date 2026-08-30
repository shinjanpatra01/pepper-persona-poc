import { dirname, join } from "node:path";
import { flagString, parseArgs } from "../lib/args.js";
import { readJson, writeJson, writeText } from "../lib/io.js";
import { describeLlm } from "../lib/llm.js";
import { generatePrompt } from "../persona/generatePrompt.js";
import { AgentSpecSchema, TranscriptSchema } from "../types.js";

/**
 * Stage 3 of the pipeline (PRD 2, "Prompt Generator").
 *
 *   npm run prompt -- examples/recording-1/agent-spec.json
 */
const USAGE = `
Usage:
  npm run prompt -- <path/to/agent-spec.json> [--out=<dir>]

Writes system-prompt.txt and first-message.txt next to the spec.
`.trim();

async function main() {
  const { positionals, flags } = parseArgs();
  const specPath = positionals[0];

  if (!specPath || flags.help) {
    console.log(USAGE);
    process.exit(specPath ? 0 : 1);
  }

  const spec = await readJson(specPath, AgentSpecSchema);

  // The transcript sits next to the spec and carries the detected language.
  // Read opportunistically: a hand-written spec with no transcript beside it
  // still generates, just in English.
  const transcript = await readJson(
    join(dirname(specPath), "transcript.json"),
    TranscriptSchema
  ).catch(() => null);
  const language = transcript?.language;

  console.log(`Generating a system prompt for "${spec.role}" using ${describeLlm()}...`);
  if (language && language.language !== "en") {
    console.log(
      `  Writing it in ${language.label}` +
        (language.code_mixed ? ", code-mixed with English" : "") +
        ", because that is what the source agent spoke."
    );
  }

  const { systemPrompt, firstMessage, idleMessages, warnings } =
    await generatePrompt(spec, language);

  const outDir = flagString(flags, "out") ?? dirname(specPath);
  const promptPath = join(outDir, "system-prompt.txt");
  const firstPath = join(outDir, "first-message.txt");
  const idlePath = join(outDir, "idle-messages.json");

  await writeText(promptPath, systemPrompt + "\n");
  await writeText(firstPath, firstMessage + "\n");
  await writeJson(idlePath, idleMessages);

  console.log(`\nFirst message`);
  console.log("-------------");
  console.log(`  "${firstMessage}"`);

  console.log(`\nWhen the caller goes quiet`);
  console.log("--------------------------");
  for (const line of idleMessages) console.log(`  "${line}"`);

  console.log(`\nSections produced`);
  console.log("-----------------");
  for (const line of systemPrompt.split("\n")) {
    if (line.startsWith("#")) console.log(`  ${line.replace(/^#+\s*/, "")}`);
  }

  const words = systemPrompt.split(/\s+/).filter(Boolean).length;
  console.log(`\n${words} words.`);

  if (warnings.length > 0) {
    console.log("\nWarnings");
    console.log("--------");
    for (const warning of warnings) console.log(`  ! ${warning}`);
  }

  console.log(`\nWrote ${promptPath}`);
  console.log(`Wrote ${firstPath}`);
  console.log(`Wrote ${idlePath}`);
}

main().catch((error) => {
  console.error(`\nPrompt generation failed: ${(error as Error).message}`);
  process.exit(1);
});
