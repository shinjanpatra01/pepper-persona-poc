import { z } from "zod";
import { completeJson } from "../lib/llm.js";
import type { Transcript, TranscriptTurn } from "../types.js";

/**
 * Repair speaker labels using conversational logic instead of acoustics.
 *
 * Deepgram separates voices by how they SOUND. When two speakers have similar
 * voices on compressed phone audio it mislabels them, or collapses both into
 * one speaker entirely - on our sales recording it assigned the whole first 25
 * seconds, question and answer alike, to a single speaker. An LLM has the
 * signal the acoustic model lacks: it knows "Hello, speaking" is the person who
 * ANSWERED, and that a reply comes from whoever did not ask.
 *
 * WHY THIS ASKS FOR WORD RANGES RATHER THAN TEXT
 * The obvious implementation - "here is the transcript, return it relabelled" -
 * lets the model quietly rewrite words, and a rewritten transcript silently
 * corrupts every downstream persona claim, including the verbatim quotes in
 * evidence.signature_phrases. An earlier version of this file did exactly that
 * and had to verify the output word by word; weaker models failed the check
 * routinely (gemini-2.5-flash turned one "well" into "okay") and lost the whole
 * repair over a single token.
 *
 * So the model never handles the text. It sees numbered words and returns
 * spans - "words 1 to 4 are the customer, 5 to 31 are the agent". We rebuild
 * the turns from OUR word array. Altering the transcript is not something the
 * model is trusted not to do; it is something it cannot do.
 */

const SpansSchema = z.object({
  spans: z.array(
    z.object({
      speaker: z.enum(["agent", "customer"]),
      /** 1-based, inclusive, into the numbered word list. */
      start: z.number(),
      end: z.number(),
    })
  ),
});

const SYSTEM_PROMPT = `
You are correcting the speaker labels on a phone call transcript.

The words below are numbered in the order they were spoken. They were split
into speakers by an automatic system that separates voices acoustically, and
that system is unreliable: it merges speakers whose voices are similar and
frequently attaches short interjections to the wrong person. Your advantage
over it is that you understand conversation.

Divide the whole word sequence into consecutive spans, each belonging to one of
exactly two people:
  - "agent": the professional running the call. On an outbound call this is
    whoever pitches, qualifies, handles objections and asks for the meeting.
    On an inbound call this is whoever answers on behalf of the business.
  - "customer": the other party.

Use conversational logic:
  - "Hello?" or "<name> speaking" is the person who ANSWERED the phone.
  - The answer to a question comes from the other speaker than the question.
  - Back-channels ("yeah", "okay", "sure", "go on") usually belong to the
    listener, not to whoever is speaking around them.
  - A speaker rarely answers their own question.

RULES FOR THE SPANS
  - The first span must start at word 1.
  - Each span must start at the word immediately after the previous span ends.
  - The last span must end at the final word.
  - Consecutive spans must alternate speakers.
Do not return the words themselves - only the numbers and the speaker.
`.trim();

/** Split turns into a flat word array while remembering the current labels. */
function flatten(turns: TranscriptTurn[]): { word: string; speaker: string }[] {
  return turns.flatMap((turn) =>
    turn.text
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => ({ word, speaker: turn.speaker }))
  );
}

/**
 * Force the model's spans into a valid cover of the word list.
 *
 * Because the words themselves are ours, a sloppy span list degrades boundary
 * accuracy but can never lose or alter text. So we repair the spans rather
 * than rejecting the whole pass: gaps are absorbed by the preceding span,
 * overlaps are trimmed, out-of-range values clamped.
 */
function normaliseSpans(
  spans: { speaker: "agent" | "customer"; start: number; end: number }[],
  wordCount: number
): { speaker: "agent" | "customer"; start: number; end: number }[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const result: typeof sorted = [];
  let cursor = 1;

  for (const span of sorted) {
    const start = Math.max(cursor, Math.min(span.start, wordCount));
    const end = Math.max(start, Math.min(span.end, wordCount));
    if (start > wordCount) break;

    const previous = result[result.length - 1];
    if (previous && previous.speaker === span.speaker) {
      previous.end = end; // merge rather than emit two spans in a row
    } else {
      result.push({ speaker: span.speaker, start, end });
    }
    cursor = end + 1;
  }

  if (result.length === 0) return [];
  // Any trailing words the model forgot about join the final span.
  result[result.length - 1]!.end = wordCount;
  return result;
}

export interface RepairResult {
  transcript: Transcript;
  applied: boolean;
  note: string;
}

export async function repairSpeakers(
  transcript: Transcript
): Promise<RepairResult> {
  const words = flatten(transcript.turns);

  if (words.length === 0) {
    return { transcript, applied: false, note: "Repair skipped: empty transcript." };
  }

  // 12 numbered words per line keeps the prompt readable for the model and
  // keeps the indices visually close to the words they label.
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += 12) {
    lines.push(
      words
        .slice(i, i + 12)
        .map((w, j) => `${i + j + 1}:${w.word}`)
        .join(" ")
    );
  }

  const currentLabels = transcript.turns
    .map((t, i) => `  turn ${i + 1}: ${t.speaker}`)
    .join("\n");

  const { spans } = await completeJson({
    schema: SpansSchema,
    schemaName: "speaker_spans",
    temperature: 0,
    system: SYSTEM_PROMPT,
    user:
      `The call has ${words.length} words.\n\n` +
      `Current (unreliable) labelling, for reference only:\n${currentLabels}\n\n` +
      `NUMBERED WORDS\n${lines.join("\n")}\n\n` +
      `Return spans covering words 1 to ${words.length}.`,
  });

  const normalised = normaliseSpans(spans, words.length);
  if (normalised.length < 2) {
    return {
      transcript,
      applied: false,
      note:
        "Repair REJECTED: the model produced fewer than two speaker spans, " +
        "which cannot be a two-party call. Keeping the original diarisation.",
    };
  }

  const turns: TranscriptTurn[] = normalised.map((span) => ({
    speaker: span.speaker,
    text: words
      .slice(span.start - 1, span.end)
      .map((w) => w.word)
      .join(" "),
  }));

  // Text integrity is guaranteed by construction, but assert it anyway: this
  // is the invariant the whole design exists to protect.
  const before = words.map((w) => w.word).join(" ");
  const after = turns.map((t) => t.text).join(" ");
  if (before !== after) {
    throw new Error(
      "Internal error: span reconstruction changed the transcript text."
    );
  }

  const moved = words.filter((w, i) => {
    const span = normalised.find((s) => i + 1 >= s.start && i + 1 <= s.end);
    return span && span.speaker !== w.speaker;
  }).length;

  return {
    transcript: { ...transcript, turns },
    applied: true,
    note:
      `Repair applied: ${transcript.turns.length} -> ${turns.length} turns, ` +
      `${moved} of ${words.length} words reassigned. Text preserved by ` +
      `construction (the model never sees or returns the words).`,
  };
}
