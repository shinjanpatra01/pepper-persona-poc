import { z } from "zod";
import { lookupLanguage } from "../audio/languages.js";
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

/**
 * Conversational cues that mark a listener rather than a speaker, per language.
 *
 * The English list was doing nothing on a Hindi call. "Hello?" and "yeah, okay,
 * sure" simply do not appear in a Hindi property call, so every example the
 * model had been given was inapplicable and it fell back on guessing - which is
 * how an agent line ("मैं गौर सन्स डेवलपर्स की तरफ से बात कर रहा हूं") ended up
 * labelled as the customer. Back-channels are the highest-signal words in the
 * whole transcript for this task, and they are entirely language-specific.
 */
const BACK_CHANNELS: Record<string, { answering: string; listening: string }> = {
  hi: {
    answering: '"हैलो", "जी", "हाँ जी", "बोलिए" or "कौन बोल रहा है"',
    listening: '"जी", "हाँ", "अच्छा", "ठीक है", "हम्म", "जी जी" or "बताइए"',
  },
  "hi-Latn": {
    answering: '"hello", "ji", "haan ji", "boliye" or "kaun bol raha hai"',
    listening: '"ji", "haan", "accha", "theek hai", "hmm" or "bataiye"',
  },
  bn: { answering: '"হ্যালো", "হ্যাঁ" or "কে বলছেন"', listening: '"হ্যাঁ", "আচ্ছা", "ঠিক আছে" or "হুম"' },
  mr: { answering: '"हॅलो", "हो", "बोला" or "कोण बोलतंय"', listening: '"हो", "बरं", "ठीक आहे" or "हम्म"' },
  gu: { answering: '"હેલો", "હા" or "કોણ બોલે છે"', listening: '"હા", "સારું", "ઠીક છે" or "હમ્મ"' },
  pa: { answering: '"ਹੈਲੋ", "ਹਾਂ ਜੀ" or "ਕੌਣ ਬੋਲ ਰਿਹਾ"', listening: '"ਹਾਂ ਜੀ", "ਅੱਛਾ", "ਠੀਕ ਹੈ" or "ਹਮ"' },
  ta: { answering: '"ஹலோ", "சொல்லுங்க" or "யாரு பேசுறீங்க"', listening: '"ஆமா", "சரி", "ஓகே" or "ம்ம்"' },
  te: { answering: '"హలో", "చెప్పండి" or "ఎవరు మాట్లాడుతున్నారు"', listening: '"అవును", "సరే", "ఓకే" or "ఊ"' },
  kn: { answering: '"ಹಲೋ", "ಹೇಳಿ" or "ಯಾರು ಮಾತಾಡ್ತಿದೀರಾ"', listening: '"ಹೌದು", "ಸರಿ", "ಓಕೆ" or "ಹೂಂ"' },
  ml: { answering: '"ഹലോ", "പറയൂ" or "ആരാ സംസാരിക്കുന്നത്"', listening: '"അതെ", "ശരി", "ഓക്കെ" or "ഉം"' },
  ur: { answering: '"ہیلو", "جی", "ہاں جی" or "کون بول رہا ہے"', listening: '"جی", "ہاں", "اچھا", "ٹھیک ہے" or "بتائیے"' },
};

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
  - A greeting or "<name> speaking" is the person who ANSWERED the phone.
  - The answer to a question comes from the other speaker than the question.
  - Back-channels usually belong to the listener, not to whoever is speaking
    around them.
  - A speaker rarely answers their own question.
  - Whoever introduces themselves on behalf of a company is the agent, every
    time they do it. If the same self-introduction appears twice in the call,
    both instances belong to the same person.

SILENCE MARKERS
The word list contains markers of the form [+1.8s] wherever the acoustic system
detected a pause between its own turns. These are measured, not guessed, and
they are the one piece of evidence you do not otherwise have:
  - A long pause is very likely a speaker change.
  - Words with no marker between them were spoken continuously and are very
    likely the same person.
Prefer to place your span boundaries ON these markers. Only cross one, or split
inside an unmarked run, when the conversational logic is unambiguous.

RULES FOR THE SPANS
  - The first span must start at word 1.
  - Each span must start at the word immediately after the previous span ends.
  - The last span must end at the final word.
  - Consecutive spans must alternate speakers.
Do not return the words themselves - only the numbers and the speaker.
`.trim();

interface FlatWord {
  word: string;
  speaker: string;
  /** Seconds of silence immediately BEFORE this word, at a turn boundary. */
  gapBefore: number;
  /** Interpolated timestamp, so repaired turns keep usable start/end values. */
  at: number;
}

/**
 * Split turns into a flat word array, keeping the acoustic evidence attached.
 *
 * The previous version threw away timings and handed the model bare words. That
 * discarded the strongest diarisation signal there is: a two-second silence
 * between two of Deepgram's turns is near-proof of a speaker change, and it is
 * measured rather than inferred. Carrying the inter-turn gaps through means the
 * repair pass can correct the labels without being blind to the acoustics that
 * produced them.
 *
 * Within a turn we only have its start and end, so word times are interpolated.
 * That is accurate enough for the boundaries, which is all they are used for.
 */
function flatten(turns: TranscriptTurn[]): FlatWord[] {
  const flat: FlatWord[] = [];
  let previousEnd: number | null = null;

  for (const turn of turns) {
    const words = turn.text.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    const start: number = turn.start ?? previousEnd ?? 0;
    const end: number = turn.end ?? start;
    const step = words.length > 1 ? (end - start) / words.length : 0;
    const gap = previousEnd !== null ? Math.max(0, start - previousEnd) : 0;

    words.forEach((word, i) => {
      flat.push({
        word,
        speaker: turn.speaker,
        gapBefore: i === 0 ? gap : 0,
        at: start + step * i,
      });
    });

    previousEnd = end;
  }

  return flat;
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
  const row = transcript.language
    ? lookupLanguage(transcript.language.language)
    : undefined;

  if (words.length === 0) {
    return { transcript, applied: false, note: "Repair skipped: empty transcript." };
  }

  // 12 numbered words per line keeps the prompt readable for the model and
  // keeps the indices visually close to the words they label. Silence markers
  // are inlined so a pause sits visually between the words it separates.
  // Anything under 0.25s is ordinary within-speech breathing, not a boundary.
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += 12) {
    lines.push(
      words
        .slice(i, i + 12)
        .map((w, j) => {
          const marker = w.gapBefore >= 0.25 ? `[+${w.gapBefore.toFixed(1)}s] ` : "";
          return `${marker}${i + j + 1}:${w.word}`;
        })
        .join(" ")
    );
  }

  const currentLabels = transcript.turns
    .map((t, i) => `  turn ${i + 1}: ${t.speaker}`)
    .join("\n");

  // Language-specific cues, when we know the language. Without this the model
  // is given English examples for a Hindi call and has nothing to match on.
  const cues = row ? BACK_CHANNELS[row.code] : undefined;
  const languageNote = row
    ? `\nThis call is in ${row.label}` +
      (transcript.language?.code_mixed
        ? ", with English words mixed in throughout"
        : "") +
      ". Reason about it in that language; do not translate it.\n" +
      (cues
        ? `In ${row.label}, the person who ANSWERED typically opens with ` +
          `${cues.answering}. The LISTENER's back-channels are ${cues.listening} ` +
          "- these are short and belong to whoever is NOT holding the floor, " +
          "even when the acoustic system attached them to the speaker.\n"
        : "")
    : "";

  const { spans } = await completeJson({
    schema: SpansSchema,
    schemaName: "speaker_spans",
    temperature: 0,
    system: SYSTEM_PROMPT,
    user:
      `The call has ${words.length} words.` +
      languageNote +
      `\n` +
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

  // Timings are carried through rather than dropped. The previous version
  // returned turns with no start/end, which left the UI unable to seek to a
  // turn in the audio and made a repaired transcript harder to check by ear
  // than an unrepaired one - the opposite of what a repair should do.
  const turns: TranscriptTurn[] = normalised.map((span) => {
    const slice = words.slice(span.start - 1, span.end);
    return {
      speaker: span.speaker,
      text: slice.map((w) => w.word).join(" "),
      start: slice[0]?.at,
      end: slice[slice.length - 1]?.at,
    };
  });

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
