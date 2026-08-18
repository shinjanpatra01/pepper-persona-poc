import { z } from "zod";
import { completeJson } from "../lib/llm.js";
import {
  AGENT_GENERATION_SYSTEM_PROMPT,
  buildAgentGenerationUserPrompt,
} from "../prompts/agentGenerationPrompt.js";
import type { AgentSpec } from "../types.js";

const GeneratedPromptSchema = z.object({
  system_prompt: z.string(),
  first_message: z.string(),
});

const REQUIRED_SECTIONS = [
  "Identity",
  "Objective",
  "Voice and Tone",
  "Response Rules",
  "Conversation Flow",
  "Objection Handling",
  "Closing",
  "Guardrails",
];

/** Words too common to prove a hard rule survived into the prompt. */
const STOPWORDS = new Set([
  "always",
  "never",
  "should",
  "customer",
  "caller",
  "answer",
  "question",
  "questions",
  "before",
  "after",
  "during",
  "without",
  "instead",
  "directly",
  "specific",
]);

export interface PromptResult {
  systemPrompt: string;
  firstMessage: string;
  warnings: string[];
}

/**
 * Turn an Agent Spec into a Vapi-ready system prompt (PRD 4.1).
 *
 * The generator itself is persona-free: it is handed the spec and knows only
 * what a good voice prompt looks like structurally. The checks below exist
 * because "the LLM wrote something plausible" is not the same as "the LLM
 * carried the spec through" - and a prompt that quietly drops the persona is
 * indistinguishable from a working one until you place a test call.
 */
export async function generatePrompt(spec: AgentSpec): Promise<PromptResult> {
  const generated = await completeJson({
    schema: GeneratedPromptSchema,
    schemaName: "generated_prompt",
    // Slightly above zero: this step is writing, not extraction.
    temperature: 0.3,
    system: AGENT_GENERATION_SYSTEM_PROMPT,
    user: buildAgentGenerationUserPrompt(spec),
  });

  const warnings: string[] = [];
  const prompt = generated.system_prompt;
  const lower = prompt.toLowerCase();

  // 1. Structure. A missing section usually means a spec field was thin.
  const missing = REQUIRED_SECTIONS.filter(
    (section) => !lower.includes(section.toLowerCase())
  );
  if (missing.length > 0) {
    warnings.push(`Missing expected section(s): ${missing.join(", ")}.`);
  }

  // 2. Hard-rule survival. Every rule in the spec is meant to reach the
  //    prompt; this is a keyword-level smoke test, not a proof.
  const droppedRules = spec.behavioural_rules.hard_rules.filter((rule) => {
    const distinctive = rule
      .toLowerCase()
      .split(/[^a-z']+/)
      .filter((w) => w.length > 5 && !STOPWORDS.has(w));
    if (distinctive.length === 0) return false;
    return !distinctive.some((word) => lower.includes(word));
  });
  if (droppedRules.length > 0) {
    warnings.push(
      `${droppedRules.length} hard rule(s) may not have reached the prompt: ` +
        droppedRules.map((r) => `"${r}"`).join("; ")
    );
  }

  // 3. Length sanity in both directions.
  const words = prompt.split(/\s+/).filter(Boolean).length;
  if (words < 250) {
    warnings.push(
      `The prompt is only ${words} words, which is thin for eight sections. ` +
        "Check that the spec was not mostly empty."
    );
  }
  if (words > 1400) {
    warnings.push(
      `The prompt is ${words} words. Very long prompts dilute instruction ` +
        "following in real-time voice models; consider trimming."
    );
  }

  // 4. The opener is spoken aloud, so it must be short and clean.
  const firstWords = generated.first_message.split(/\s+/).filter(Boolean).length;
  if (firstWords > 45) {
    warnings.push(
      `The first message is ${firstWords} words. That is a long thing to say ` +
        "before the other person can speak."
    );
  }
  if (/[*_#`\[\]]/.test(generated.first_message)) {
    warnings.push("The first message contains markdown characters; it is spoken aloud.");
  }

  return {
    systemPrompt: prompt,
    firstMessage: generated.first_message.trim(),
    warnings,
  };
}
