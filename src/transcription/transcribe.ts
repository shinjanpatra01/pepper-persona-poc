import type { Transcript, TranscriptTurn } from "../types.js";
import { transcribeWithDeepgram, type DeepgramUtterance } from "./deepgram.js";
import { measureProsody } from "./prosody.js";
import { decideAgentSpeaker, type SpeakerDecision } from "./speakers.js";

export interface TranscribeOptions {
  /** Local audio file path, or a direct https URL to a media file. */
  source: string;
  /** Free-text note about where the recording came from (PRD 3.1). */
  notes?: string;
  /** Force which Deepgram speaker number is the agent, skipping the heuristic. */
  agentSpeaker?: number;
}

export interface TranscribeResult {
  transcript: Transcript;
  decision: SpeakerDecision;
  /** True when the caller overrode the heuristic. */
  overridden: boolean;
}

/**
 * Consecutive utterances from the same speaker are merged into a single turn.
 *
 * Deepgram splits on pauses, so one spoken sentence often arrives as three
 * utterances. Merging gives the Phase 3 analyser real conversational turns,
 * which matters because we ask it to judge response LENGTH - unmerged
 * fragments would make every agent look terse.
 */
function toTurns(
  utterances: DeepgramUtterance[],
  agentSpeaker: number
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];

  for (const u of utterances) {
    if (!u.transcript) continue;
    const speaker = u.speaker === agentSpeaker ? "agent" : "customer";
    const previous = turns[turns.length - 1];

    if (previous && previous.speaker === speaker) {
      previous.text = `${previous.text} ${u.transcript}`.trim();
      previous.end = u.end;
    } else {
      turns.push({
        speaker,
        text: u.transcript,
        start: u.start,
        end: u.end,
      });
    }
  }

  return turns;
}

export async function buildTranscript(
  options: TranscribeOptions
): Promise<TranscribeResult> {
  const utterances = await transcribeWithDeepgram(options.source);
  const decision = decideAgentSpeaker(utterances);

  const overridden = options.agentSpeaker !== undefined;
  const agentSpeaker = options.agentSpeaker ?? decision.agentSpeaker;

  // Prosody is measured here, against the raw Deepgram utterances, because the
  // optional LLM repair pass later re-segments the text and drops timings. The
  // numbers therefore reflect the ACOUSTIC speaker assignment; if the repair
  // pass swaps a few boundaries the effect on aggregate rate and pause
  // statistics is negligible, but it is a real caveat worth documenting.
  const customerSpeakers = [
    ...new Set(utterances.map((u) => u.speaker)),
  ].filter((s) => s !== agentSpeaker);

  return {
    transcript: {
      source: options.source,
      notes: options.notes,
      turns: toTurns(utterances, agentSpeaker),
      prosody: {
        agent: measureProsody(utterances, agentSpeaker),
        customer: measureProsody(utterances, customerSpeakers[0] ?? -1),
      },
    },
    decision,
    overridden,
  };
}
