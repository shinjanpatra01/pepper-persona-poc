import type { DeepgramUtterance } from "./deepgram.js";

/**
 * Prosody measured from Deepgram's word timings.
 *
 * PRD 5 lists speaking speed and pause timing among the things a transcript
 * cannot capture. That is true of the TEXT, but not of the timings we already
 * receive alongside it and were previously throwing away. These numbers cost
 * nothing extra and are objective, which makes them the trustworthy half of
 * the voice profile - everything the multimodal model says about accent and
 * timbre is judgement, whereas this is arithmetic.
 */
export interface ProsodyFeatures {
  /** Words per minute counted only while this speaker is actually talking. */
  words_per_minute: number;
  /** Total seconds this speaker held the floor. */
  speaking_seconds: number;
  /** Share of the call this speaker occupied, 0-1. */
  talk_ratio: number;
  /** Mean silence between consecutive words inside a turn, seconds. */
  mean_intra_turn_pause: number;
  /** Deliberate pauses (>0.4s mid-turn) per 100 words. */
  long_pauses_per_100_words: number;
  /** Mean seconds before this speaker starts replying to the other one. */
  mean_response_latency: number;
  /** Mean length of one uninterrupted turn, seconds. */
  mean_turn_duration: number;
  /**
   * Start/end of each stretch where only this speaker is talking. Used to cut
   * an isolated voice sample: feeding mixed audio to the voice analyser would
   * have it describe an average of both people.
   */
  segments: { start: number; end: number }[];
}

const mean = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

const round = (value: number, places = 2) =>
  Math.round(value * 10 ** places) / 10 ** places;

export function measureProsody(
  utterances: DeepgramUtterance[],
  speaker: number
): ProsodyFeatures {
  const mine = utterances.filter((u) => u.speaker === speaker);

  if (mine.length === 0 || mine.every((u) => u.words.length === 0)) {
    // Word timings are missing (some Deepgram models omit them). Report zeros
    // rather than inventing numbers; the caller warns about it.
    return {
      words_per_minute: 0,
      speaking_seconds: 0,
      talk_ratio: 0,
      mean_intra_turn_pause: 0,
      long_pauses_per_100_words: 0,
      mean_response_latency: 0,
      mean_turn_duration: 0,
      segments: [],
    };
  }

  const speakingSeconds = mine.reduce((sum, u) => sum + (u.end - u.start), 0);
  const wordCount = mine.reduce((sum, u) => sum + u.words.length, 0);

  // Total call span, used for talk ratio.
  const callStart = Math.min(...utterances.map((u) => u.start));
  const callEnd = Math.max(...utterances.map((u) => u.end));
  const callSeconds = Math.max(callEnd - callStart, 1);

  // Gaps between consecutive words WITHIN a turn. Cross-turn gaps are excluded
  // because those measure turn-taking, not this speaker's rhythm.
  const gaps: number[] = [];
  for (const utterance of mine) {
    for (let i = 1; i < utterance.words.length; i++) {
      const gap = utterance.words[i]!.start - utterance.words[i - 1]!.end;
      if (gap >= 0) gaps.push(gap);
    }
  }
  const longPauses = gaps.filter((g) => g > 0.4).length;

  // How long this speaker waits before answering the other party. A short
  // latency reads as eager or interruptive; a long one as considered.
  const latencies: number[] = [];
  for (let i = 1; i < utterances.length; i++) {
    const previous = utterances[i - 1]!;
    const current = utterances[i]!;
    if (current.speaker === speaker && previous.speaker !== speaker) {
      const latency = current.start - previous.end;
      // Negative means overlap (interruption); clamp so it does not skew the
      // mean, but keep it as zero rather than dropping the data point.
      latencies.push(Math.max(latency, 0));
    }
  }

  return {
    words_per_minute: round((wordCount / speakingSeconds) * 60, 1),
    speaking_seconds: round(speakingSeconds, 1),
    talk_ratio: round(speakingSeconds / callSeconds, 2),
    mean_intra_turn_pause: round(mean(gaps), 3),
    long_pauses_per_100_words: round((longPauses / Math.max(wordCount, 1)) * 100, 1),
    mean_response_latency: round(mean(latencies), 2),
    mean_turn_duration: round(speakingSeconds / mine.length, 1),
    segments: mine.map((u) => ({ start: round(u.start), end: round(u.end) })),
  };
}
