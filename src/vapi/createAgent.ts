import { optionalEnv } from "../lib/env.js";
import type { AgentSpec } from "../types.js";
import { vapi, type VapiAssistant } from "./client.js";
import type { VoiceSelection } from "./voiceMapping.js";

/**
 * Create or update the recreated agent in Vapi (PRD 4.2).
 *
 * PRD 4.2 says to use Vapi defaults wherever possible for model, STT, TTS and
 * turn handling. That is a real design choice, not laziness: the POC is testing
 * whether the extracted PERSONA transfers, so every knob we leave at default is
 * one fewer variable confounding that answer. The only things we set are the
 * ones that carry the persona - the system prompt and the opening line.
 */
export interface CreateAgentInput {
  spec: AgentSpec;
  systemPrompt: string;
  firstMessage: string;
  /** Recording folder name, used to make the assistant recognisable in the UI. */
  label: string;
  /** Update this assistant instead of creating a new one. */
  existingAssistantId?: string;
  /**
   * Chosen from the audio-derived voice profile, when the optional voice pass
   * has been run. Omitted, Vapi picks its own default voice - which keeps the
   * transcript-only path a clean control for the PRD 5 comparison.
   */
  voice?: VoiceSelection;
}

export interface CreateAgentResult {
  assistant: VapiAssistant;
  created: boolean;
}

export async function createOrUpdateAgent(
  input: CreateAgentInput
): Promise<CreateAgentResult> {
  // Vapi caps assistant names at 40 characters.
  const name = `${input.label} - ${input.spec.role}`.slice(0, 40);

  const payload: Record<string, unknown> = {
    name,
    firstMessage: input.firstMessage,
    model: {
      provider: "openai",
      model: optionalEnv("VAPI_MODEL", "gpt-4o"),
      messages: [{ role: "system", content: input.systemPrompt }],
    },
    // transcriber, turn detection and endpointing are intentionally omitted so
    // Vapi applies its defaults (PRD 4.2).
  };

  // Voice is the one default we override, and only when we have measured
  // evidence for it. Accent, gender and rate are the parts of a persona a
  // stock TTS voice can actually carry.
  if (input.voice) {
    payload.voice = {
      provider: input.voice.provider,
      voiceId: input.voice.voiceId,
      speed: input.voice.speed,
    };
  }

  if (input.existingAssistantId) {
    const assistant = await vapi.patch<VapiAssistant>(
      `/assistant/${input.existingAssistantId}`,
      payload
    );
    return { assistant, created: false };
  }

  const assistant = await vapi.post<VapiAssistant>("/assistant", payload);
  return { assistant, created: true };
}
