import { completeJson } from "../lib/llm.js";
import {
  PERSONA_ANALYSIS_SYSTEM_PROMPT,
  buildPersonaAnalysisUserPrompt,
} from "../prompts/personaAnalysisPrompt.js";
import { AgentSpecSchema, type AgentSpec, type Transcript } from "../types.js";

/** Objective facts measured from the transcript, not guessed by the model. */
export interface TranscriptStats {
  totalTurns: number;
  agentTurns: number;
  customerTurns: number;
  agentWords: number;
  avgWordsPerAgentTurn: number;
  agentQuestions: number;
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

export function measureTranscript(transcript: Transcript): TranscriptStats {
  const agent = transcript.turns.filter((t) => t.speaker === "agent");
  const agentWords = agent.reduce((sum, t) => sum + words(t.text), 0);

  return {
    totalTurns: transcript.turns.length,
    agentTurns: agent.length,
    customerTurns: transcript.turns.length - agent.length,
    agentWords,
    avgWordsPerAgentTurn: agent.length
      ? Math.round((agentWords / agent.length) * 10) / 10
      : 0,
    agentQuestions: agent.reduce(
      (sum, t) => sum + (t.text.match(/\?/g) ?? []).length,
      0
    ),
  };
}

/**
 * The LLM analysis step (PRD 3.3): transcript in, structured Agent Spec out.
 *
 * The response is schema-enforced by the provider and re-validated by Zod
 * inside completeJson, so this function either returns a valid AgentSpec or
 * throws - it never returns something half-formed for a later stage to trip on.
 */
export async function analyzeTranscript(
  transcript: Transcript,
  stats: TranscriptStats
): Promise<AgentSpec> {
  return completeJson({
    schema: AgentSpecSchema,
    schemaName: "agent_spec",
    temperature: 0, // extraction should be repeatable, not creative
    system: PERSONA_ANALYSIS_SYSTEM_PROMPT,
    user: buildPersonaAnalysisUserPrompt({
      transcript,
      agentTurnCount: stats.agentTurns,
      avgWordsPerAgentTurn: stats.avgWordsPerAgentTurn,
    }),
  });
}
