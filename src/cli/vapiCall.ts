import { join } from "node:path";
import { z } from "zod";
import { flagString, parseArgs } from "../lib/args.js";
import { readJson, writeJson } from "../lib/io.js";
import { getCall, placeCall } from "../vapi/makeCall.js";

/**
 * Stage 5 of the pipeline (PRD 4.3): place one real outbound test call.
 *
 *   npm run vapi:call -- examples/recording-1
 *   npm run vapi:call -- examples/recording-1 --to=+919876543210
 *   npm run vapi:call -- examples/recording-1 --status   # poll the last call
 */
const USAGE = `
Usage:
  npm run vapi:call -- <examples/recording-N> [options]

Options:
  --to=<+E164>   Number to call. Defaults to TEST_PHONE_NUMBER from .env.
  --status       Do not dial; fetch the result of the last call instead.

Writes call-result.json into the recording folder.
`.trim();

const AssistantRecordSchema = z.object({ assistantId: z.string() });
const CallRecordSchema = z.object({ callId: z.string() }).loose();

async function main() {
  const { positionals, flags } = parseArgs();
  const dir = positionals[0];

  if (!dir || flags.help) {
    console.log(USAGE);
    process.exit(dir ? 0 : 1);
  }

  const resultPath = join(dir, "call-result.json");

  /* -------- polling mode -------- */
  if (flags.status) {
    const previous = await readJson(resultPath, CallRecordSchema);
    const call = await getCall(previous.callId);

    console.log(`Call ${call.id}`);
    console.log(`  status  : ${call.status}`);
    console.log(`  ended   : ${call.endedReason ?? "-"}`);
    console.log(`  recording: ${call.recordingUrl ?? "not ready yet"}`);
    if (call.transcript) {
      console.log("\nTranscript\n----------");
      console.log(call.transcript);
    }

    await writeJson(resultPath, { ...previous, ...call });
    console.log(`\nUpdated ${resultPath}`);
    return;
  }

  /* -------- dialling mode -------- */
  const { assistantId } = await readJson(
    join(dir, "vapi-assistant.json"),
    AssistantRecordSchema
  );

  const to = flagString(flags, "to") ?? process.env.TEST_PHONE_NUMBER?.trim();
  if (!to) {
    throw new Error("No destination. Pass --to=+E164 or set TEST_PHONE_NUMBER in .env.");
  }

  console.log(`Calling ${to} with assistant ${assistantId}...`);
  const call = await placeCall({ assistantId, to });

  // The POST returns as soon as the call is queued, so the interesting fields
  // are not populated yet. We store the id and poll with --status afterwards.
  await writeJson(resultPath, {
    callId: call.id,
    assistantId,
    to,
    status: call.status,
  });

  console.log(`\nCall queued.`);
  console.log(`  call id: ${call.id}`);
  console.log(`  -> ${resultPath}`);
  console.log(`\nAnswer the phone. Afterwards run:`);
  console.log(`  npm run vapi:call -- ${dir} --status`);
}

main().catch((error) => {
  console.error(`\nvapi:call failed: ${(error as Error).message}`);
  process.exit(1);
});
