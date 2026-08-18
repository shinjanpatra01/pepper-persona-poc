import { dirname, join } from "node:path";
import { flagString, parseArgs } from "../lib/args.js";
import { readJson, writeText } from "../lib/io.js";
import { describeLlm } from "../lib/llm.js";
import { generatePrompt } from "../persona/generatePrompt.js";
import { AgentSpecSchema } from "../types.js";

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

  console.log(`Generating a system prompt for "${spec.role}" using ${describeLlm()}...`);

  const { systemPrompt, firstMessage, warnings } = await generatePrompt(spec);

  const outDir = flagString(flags, "out") ?? dirname(specPath);
  const promptPath = join(outDir, "system-prompt.txt");
  const firstPath = join(outDir, "first-message.txt");

  await writeText(promptPath, systemPrompt + "\n");
  await writeText(firstPath, firstMessage + "\n");

  console.log(`\nFirst message`);
  console.log("-------------");
  console.log(`  "${firstMessage}"`);

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
}

main().catch((error) => {
  console.error(`\nPrompt generation failed: ${(error as Error).message}`);
  process.exit(1);
});
