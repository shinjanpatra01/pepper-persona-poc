import type { AgentSpec, Transcript } from "../types.js";
import {
  analyzeTranscript,
  measureTranscript,
  type TranscriptStats,
} from "./analyzeTranscript.js";

export interface AgentSpecResult {
  spec: AgentSpec;
  stats: TranscriptStats;
  /** Quality problems worth telling the operator about, not fatal. */
  warnings: string[];
}

/**
 * Produce a validated, ground-truth-corrected Agent Spec (PRD 3.4).
 *
 * Two jobs beyond calling the model:
 *
 *  1. Sanity-check the transcript BEFORE spending a request on it. A transcript
 *     with three agent turns, or with no customer at all, cannot support a
 *     persona - better to say so than to produce a confident fiction.
 *
 *  2. Overwrite avg_words_per_turn with the measured value. Everything else in
 *     the spec is the model's judgement; this one field is arithmetic, so the
 *     spec should carry the true number. It also gives you a cheap credibility
 *     check: if the model called a 60-word-per-turn agent "very_short", its
 *     other judgements deserve scepticism too.
 */
export async function generateAgentSpec(
  transcript: Transcript
): Promise<AgentSpecResult> {
  const stats = measureTranscript(transcript);
  const warnings: string[] = [];

  if (stats.agentTurns === 0) {
    throw new Error(
      "The transcript contains no agent turns. Speaker assignment probably " +
        "failed - rerun the transcribe step with --agent=<n>."
    );
  }
  if (stats.customerTurns === 0) {
    throw new Error(
      "The transcript contains no customer turns, so this is a monologue " +
        "rather than a call. Check diarisation before analysing."
    );
  }
  if (stats.agentTurns < 5) {
    warnings.push(
      `Only ${stats.agentTurns} agent turns. That is thin evidence for a ` +
        "persona; treat the spec's confidence field with suspicion."
    );
  }
  if (stats.agentQuestions === 0) {
    warnings.push(
      "The agent never asks a question. Either the transcript lost its " +
        "punctuation or the speakers may be swapped."
    );
  }

  const spec = await analyzeTranscript(transcript, stats);

  // Ground truth beats model judgement for a field we can simply count.
  const measuredSpec: AgentSpec = {
    ...spec,
    speaking_style: {
      ...spec.speaking_style,
      avg_words_per_turn: stats.avgWordsPerAgentTurn,
    },
  };

  const claimed = spec.speaking_style.response_length;
  const measured = stats.avgWordsPerAgentTurn;
  const expected =
    measured < 12 ? "very_short" : measured < 30 ? "short" : measured < 60 ? "medium" : "long";
  if (claimed !== expected) {
    warnings.push(
      `The model called the response length "${claimed}" but the measured ` +
        `average is ${measured} words/turn, which reads as "${expected}". ` +
        "Worth a look when you evaluate the spec."
    );
  }

  return { spec: measuredSpec, stats, warnings };
}
