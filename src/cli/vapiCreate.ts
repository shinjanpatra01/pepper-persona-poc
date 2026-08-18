import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { parseArgs } from "../lib/args.js";
import { readJson, writeJson } from "../lib/io.js";
import { AgentSpecSchema } from "../types.js";
import { createOrUpdateAgent } from "../vapi/createAgent.js";

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

  const spec = await readJson(join(dir, "agent-spec.json"), AgentSpecSchema);
  const systemPrompt = (await readFile(join(dir, "system-prompt.txt"), "utf8")).trim();
  const firstMessage = (await readFile(join(dir, "first-message.txt"), "utf8")).trim();

  const recordPath = join(dir, "vapi-assistant.json");
  let existingAssistantId: string | undefined;
  try {
    existingAssistantId = (await readJson(recordPath, AssistantRecordSchema)).assistantId;
  } catch {
    // No prior assistant for this recording; we will create one.
  }

  const label = basename(resolve(dir));
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
