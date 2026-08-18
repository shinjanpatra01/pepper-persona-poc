import type { Transcript, TranscriptTurn } from "../types.js";
import { transcribeWithDeepgram, type DeepgramUtterance } from "./deepgram.js";
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

  return {
    transcript: {
      source: options.source,
      notes: options.notes,
      turns: toTurns(utterances, agentSpeaker),
    },
    decision,
    overridden,
  };
}
