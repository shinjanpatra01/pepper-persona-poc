import { z } from "zod";
import { completeJson } from "../lib/llm.js";
import type { Transcript, TranscriptTurn } from "../types.js";

/**
 * Repair speaker labels using conversational logic instead of acoustics.
 *
 * Deepgram separates voices by how they SOUND. When two speakers have similar
 * voices on compressed phone audio it mislabels them, or collapses both into
 * one speaker entirely. On our sales recording it assigned the whole first 25
 * seconds - question and answer alike - to a single speaker.
 *
 * An LLM has the signal the acoustic model lacks: it knows "Hello, speaking"
 * is the person who ANSWERED, and that the reply to a question comes from the
 * other party. So we hand it the diarised text and ask it to re-segment.
 *
 * The obvious risk is the model quietly rewriting words instead of just
 * relabelling them, which would corrupt every downstream persona claim. So the
 * repair is verified: we compare the word sequence before and after, and if it
 * drifted we reject the repair and keep the original transcript. The repair
 * can only ever change WHO said something, never WHAT was said.
 */

const RepairedSchema = z.object({
  turns: z.array(
    z.object({
      speaker: z.enum(["agent", "customer"]),
      text: z.string(),
    })
  ),
});

const SYSTEM_PROMPT = `
You are correcting the speaker labels on a phone call transcript.

The transcript was produced by an automatic diarisation system that separates
voices acoustically. It is unreliable: it merges speakers when their voices are
similar, and it frequently attaches a short interjection to the wrong person.
Your advantage over it is that you understand conversation.

Re-segment the text into alternating turns between exactly two people:
  - "agent": the professional who is running the call. On an outbound call this
    is whoever pitches, qualifies, handles objections and asks for the meeting.
    On an inbound call this is whoever answers on behalf of the business.
  - "customer": the other party.

Use conversational logic:
  - "Hello?" or "<name> speaking" is the person who ANSWERED the phone.
  - The answer to a question comes from the other speaker than the question.
  - Back-channels ("yeah", "okay", "sure", "go on") usually belong to the
    listener, not to whoever is mid-sentence around them.
  - A speaker rarely answers their own question.

ABSOLUTE CONSTRAINT
Reproduce the words EXACTLY as given, in the same order. Do not correct
grammar, do not remove filler or stutters, do not add or drop a single word.
You are only allowed to change where turn boundaries fall and which speaker
each turn is attributed to. The words are evidence and must survive intact.
`.trim();

/** Comparable word sequence: lowercase, letters and digits only. */
function wordSignature(turns: { text: string }[]): string[] {
  return turns
    .flatMap((t) => t.text.split(/\s+/))
    .map((w) => w.toLowerCase().replace(/[^a-z0-9']/g, ""))
    .filter(Boolean);
}

export interface RepairResult {
  transcript: Transcript;
  applied: boolean;
  note: string;
}

export async function repairSpeakers(
  transcript: Transcript
): Promise<RepairResult> {
  const numbered = transcript.turns
    .map((t, i) => `${i + 1}. [${t.speaker}] ${t.text}`)
    .join("\n");

  const repaired = await completeJson({
    schema: RepairedSchema,
    schemaName: "repaired_transcript",
    temperature: 0,
    system: SYSTEM_PROMPT,
    user:
      `Diarisation output for the call (labels may be wrong):\n\n${numbered}\n\n` +
      `Return the corrected turns.`,
  });

  // Verification: the words must be identical, only the labels may move.
  const before = wordSignature(transcript.turns);
  const after = wordSignature(repaired.turns);

  if (before.length !== after.length) {
    return {
      transcript,
      applied: false,
      note:
        `Repair REJECTED: the model returned ${after.length} words but the ` +
        `original had ${before.length}. Keeping the original diarisation.`,
    };
  }

  const firstDrift = before.findIndex((w, i) => w !== after[i]);
  if (firstDrift !== -1) {
    return {
      transcript,
      applied: false,
      note:
        `Repair REJECTED: wording changed at word ${firstDrift + 1} ` +
        `("${before[firstDrift]}" became "${after[firstDrift]}"). ` +
        `Keeping the original diarisation.`,
    };
  }

  const changed = repaired.turns.length !== transcript.turns.length;
  const turns: TranscriptTurn[] = repaired.turns.map((t) => ({
    speaker: t.speaker,
    text: t.text,
  }));

  return {
    transcript: { ...transcript, turns },
    applied: true,
    note:
      `Repair applied and verified: every word preserved. ` +
      `Turn count ${transcript.turns.length} -> ${repaired.turns.length}` +
      (changed ? " (re-segmented)." : " (labels only)."),
  };
}
