import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LanguageRow } from "../audio/languages.js";
import type { DeepgramUtterance } from "./deepgram.js";
import { sarvamTranscribe } from "./sarvam.js";

const run = promisify(execFile);

/**
 * Re-transcribe an Indian-language recording with Sarvam, reusing Deepgram's
 * speaker timeline.
 *
 * The insight this whole module rests on: diarisation and transcription are
 * different problems. Working out how many voices are present and when each one
 * is talking is an acoustic task - it turns on pitch, timbre and turn-taking,
 * not on vocabulary - so Deepgram does it perfectly well on Hindi audio even
 * though the words it returns are useless. Transcription is the part that needs
 * a model trained on the language.
 *
 * So we keep the half Deepgram is good at and replace the half it is not:
 * every diarised turn is cut out of the source audio and sent to Sarvam
 * individually. Alignment is then exact by construction - each turn's text came
 * from that turn's audio - which is a much safer property than trying to map a
 * whole-file transcript back onto a speaker timeline and hoping the boundaries
 * line up.
 *
 * The cost is one API call per turn. That is the right trade for an offline
 * batch stage that runs once per recording.
 */

/** Turns shorter than this are back-channels; transcribing them is noise. */
const MIN_TURN_SECONDS = 0.35;
/**
 * Sarvam's synchronous endpoint hard-rejects audio over 30 seconds. Most turns
 * are nowhere near it, but one uninterrupted pitch is enough to fail a whole
 * recording, so long turns are split and stitched rather than dropped.
 */
const MAX_CLIP_SECONDS = 28;
/** Cutting exactly on the boundary clips word onsets, so widen slightly. */
const PAD_SECONDS = 0.15;
/** Enough parallelism to be quick, low enough not to trip Sarvam rate limits. */
const CONCURRENCY = 4;

interface Turn {
  speaker: number;
  start: number;
  end: number;
  members: DeepgramUtterance[];
}

/**
 * Group consecutive utterances from one speaker back into whole turns.
 *
 * Deepgram is deliberately configured with a tight utt_split so it does not
 * blend two voices into one label, which leaves a single sentence split across
 * three fragments. Sending those fragments to an ASR separately would be
 * actively harmful - a one-second clip gives the model no context to work with
 * - so we reassemble the turn before cutting the audio.
 */
function groupTurns(utterances: DeepgramUtterance[]): Turn[] {
  const turns: Turn[] = [];
  for (const u of utterances) {
    const previous = turns[turns.length - 1];
    if (previous && previous.speaker === u.speaker) {
      previous.end = u.end;
      previous.members.push(u);
    } else {
      turns.push({ speaker: u.speaker, start: u.start, end: u.end, members: [u] });
    }
  }
  return turns;
}

/** Split a turn into windows Sarvam will accept, with a little overlap. */
function clipWindows(turn: Turn): { start: number; duration: number }[] {
  const start = Math.max(0, turn.start - PAD_SECONDS);
  const end = turn.end + PAD_SECONDS;
  const windows: { start: number; duration: number }[] = [];

  for (let at = start; at < end; at += MAX_CLIP_SECONDS) {
    windows.push({ start: at, duration: Math.min(MAX_CLIP_SECONDS, end - at) });
  }
  return windows;
}

async function transcribeClip(
  audioPath: string,
  window: { start: number; duration: number },
  index: number,
  part: number,
  row: LanguageRow
): Promise<{ transcript: string; words: { word: string; start: number; end: number }[] }> {
  const start = window.start;
  const duration = window.duration;
  const clipPath = join(tmpdir(), `pepper-turn-${process.pid}-${index}-${part}.wav`);

  try {
    await run("ffmpeg", [
      "-y",
      "-loglevel", "error",
      "-ss", String(start),
      "-t", String(duration),
      "-i", audioPath,
      "-ac", "1",
      "-ar", "16000",
      clipPath,
    ]);

    const result = await sarvamTranscribe(await readFile(clipPath), {
      // The language is already decided; pinning it beats re-detecting per clip,
      // where a two-second turn gives the identifier almost nothing to go on.
      languageCode: row.sarvam ?? "unknown",
      /*
       * Always codemix, never plain transcribe.
       *
       * This used to be conditional on the detected code_mixed flag, which
       * created a loop that could not be escaped: detection judges code-mixing
       * from a short probe, a probe that says "no" selects transcribe mode,
       * transcribe mode transliterates every English word into Devanagari
       * ("configuration" -> "कॉन्फ़िगरेशन"), and the finished transcript then
       * measures 0.4% English - so the later full-transcript re-check confirms
       * the wrong answer it was meant to correct. One real call went round that
       * loop and produced a monolingual persona from a heavily Hinglish call.
       *
       * Unconditional codemix breaks it. On a genuinely monolingual recording
       * the mode has no English to preserve and behaves like transcribe, so
       * there is nothing to trade away.
       */
      mode: "codemix",
      withTimestamps: true,
      filename: "turn.wav",
    });

    // Sarvam times words from the start of the clip, so shift back onto the
    // recording's own clock. Prosody is measured from these, and prosody drives
    // the speaking rate we hand the TTS - an unshifted timeline would put every
    // word in the first few seconds and report an absurd words-per-minute.
    const words = result.words.map((w) => ({
      word: w.word,
      start: start + w.start,
      end: start + w.end,
    }));

    return { transcript: result.transcript, words };
  } finally {
    await rm(clipPath, { force: true });
  }
}

/**
 * Resample a turn's Deepgram word timings to hold a different number of words.
 *
 * Sarvam's with_timestamps returns CHUNK-level spans, not per-word ones - three
 * timestamps for a sixty-word turn. Fed to the prosody measurer that produced a
 * speaking rate of 7 words per minute instead of 160, and since the rate is
 * what sets the TTS speed multiplier, the agent would have been built to drawl.
 * A wrong number here is worse than a missing one because nothing downstream
 * questions it.
 *
 * The fix keeps each engine's reliable half. Deepgram's word ONSETS are
 * acoustic - it heard the same silences whatever it thought the words were - so
 * they carry the real rhythm and pauses. Sarvam supplies the real word COUNT.
 * Stretching Deepgram's timeline to Sarvam's count gives a rate computed from a
 * true numerator and a true denominator, and leaves the pause structure intact
 * rather than flattening it into an even spread.
 */
function resampleTimings(
  source: { start: number; end: number }[],
  count: number,
  fallback: { start: number; end: number }
): { start: number; end: number }[] {
  if (count <= 0) return [];
  if (source.length === 0) {
    // No acoustic timeline to borrow: spread evenly across the turn. Pause
    // statistics come out as zero, which reads as "not measured" rather than
    // as a confident wrong answer.
    const step = (fallback.end - fallback.start) / count;
    return Array.from({ length: count }, (_, i) => ({
      start: fallback.start + step * i,
      end: fallback.start + step * (i + 1),
    }));
  }

  return Array.from({ length: count }, (_, i) => {
    const slot = source[Math.min(source.length - 1, Math.floor((i * source.length) / count))]!;
    // Several words may land in one slot when Sarvam found more words than
    // Deepgram did; subdivide the slot so they do not all share one instant.
    const perSlot = Math.max(1, Math.ceil(count / source.length));
    const offset = i % perSlot;
    const width = (slot.end - slot.start) / perSlot;
    return {
      start: slot.start + width * offset,
      end: slot.start + width * (offset + 1),
    };
  });
}

async function transcribeTurn(
  audioPath: string,
  turn: Turn,
  index: number,
  row: LanguageRow
): Promise<DeepgramUtterance> {
  const windows = clipWindows(turn);
  const parts = [];
  for (const [part, window] of windows.entries()) {
    parts.push(
      await transcribeClip(audioPath, window, index, part, row)
    );
  }

  const transcript = parts.map((p) => p.transcript).join(" ").trim();
  const sarvamWords = parts.flatMap((p) => p.words);
  const tokens = transcript.split(/\s+/).filter(Boolean);

  // Sarvam is trusted for timings only when it actually returned one per word.
  // The models differ on this and have changed behaviour between versions, so
  // the check is on the data rather than on the model name.
  const perWord = sarvamWords.length >= tokens.length * 0.8;

  const words = perWord
    ? sarvamWords
    : resampleTimings(
        turn.members.flatMap((u) => u.words),
        tokens.length,
        { start: turn.start, end: turn.end }
      ).map((slot, i) => ({ word: tokens[i] ?? "", start: slot.start, end: slot.end }));

  return {
    speaker: turn.speaker,
    transcript,
    start: turn.start,
    end: turn.end,
    words,
  };
}

/** Run tasks with a fixed number in flight, preserving input order. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await task(items[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
}

export interface IndianTranscribeResult {
  utterances: DeepgramUtterance[];
  /** One line per turn that could not be transcribed, for the operator. */
  warnings: string[];
}

export async function transcribeIndianAudio(input: {
  audioPath: string;
  /** Deepgram's output, used ONLY for its speaker timeline. */
  utterances: DeepgramUtterance[];
  language: LanguageRow;
  onProgress?: (done: number, total: number) => void;
}): Promise<IndianTranscribeResult> {
  const turns = groupTurns(input.utterances).filter(
    (t) => t.end - t.start >= MIN_TURN_SECONDS
  );

  if (turns.length === 0) {
    throw new Error(
      "Deepgram found no turns long enough to re-transcribe. The recording may " +
        "be too short or diarisation may have failed entirely."
    );
  }

  const warnings: string[] = [];
  let done = 0;

  const transcribed = await mapWithLimit(turns, CONCURRENCY, async (turn, index) => {
    try {
      const result = await transcribeTurn(
        input.audioPath,
        turn,
        index,
        input.language
      );
      return result;
    } catch (error) {
      // One failed clip must not lose the other fifty turns. Drop it, say so,
      // and let the operator decide whether the gap matters.
      warnings.push(
        `Turn ${index + 1} (${turn.start.toFixed(1)}s-${turn.end.toFixed(1)}s) ` +
          `failed: ${(error as Error).message}`
      );
      return null;
    } finally {
      input.onProgress?.(++done, turns.length);
    }
  });

  const utterances = transcribed
    .filter((u): u is DeepgramUtterance => u !== null && u.transcript.length > 0);

  if (utterances.length === 0) {
    throw new Error(
      "Sarvam returned no text for any turn. Check SARVAM_API_KEY and that the " +
        "recording actually contains speech."
    );
  }

  return { utterances, warnings };
}
