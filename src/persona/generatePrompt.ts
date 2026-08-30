import { z } from "zod";
import { completeJson } from "../lib/llm.js";
import { lookupLanguage } from "../audio/languages.js";
import { readTextSignals } from "../audio/textSignals.js";
import {
  AGENT_GENERATION_SYSTEM_PROMPT,
  buildAgentGenerationUserPrompt,
  languageDirective,
} from "../prompts/agentGenerationPrompt.js";
import type { AgentSpec, AudioLanguageProfile } from "../types.js";

const GeneratedPromptSchema = z.object({
  system_prompt: z.string(),
  first_message: z.string(),
  /*
   * Spoken by Vapi when the caller goes quiet. They live here rather than in
   * the assistant config because a hardcoded "Are you still there?" in English
   * is exactly the generic seam this pipeline exists to remove - the nudge has
   * to be in the persona's own voice and language.
   */
  idle_messages: z.array(z.string()).min(2).max(4),
});

const REQUIRED_SECTIONS = [
  "Identity",
  "Objective",
  "Voice and Tone",
  "Response Rules",
  "Delivery Habits",
  "Turn Taking and Silence",
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
  idleMessages: string[];
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
export async function generatePrompt(
  spec: AgentSpec,
  /**
   * The detected language of the source call. When it is not English the
   * generator is told to write the prompt IN that language rather than about
   * it - see languageDirective for why that distinction decides whether the
   * finished agent sounds like the source speaker or like a translation.
   */
  language?: AudioLanguageProfile
): Promise<PromptResult> {
  const row = language ? lookupLanguage(language.language) : undefined;
  const targetLanguage = row && row.code !== "en" ? row : undefined;

  const system =
    AGENT_GENERATION_SYSTEM_PROMPT +
    (targetLanguage
      ? languageDirective({
          label: targetLanguage.label,
          codeMixed: language!.code_mixed,
        })
      : "");

  const generated = await completeJson({
    schema: GeneratedPromptSchema,
    schemaName: "generated_prompt",
    // Slightly above zero: this step is writing, not extraction.
    temperature: 0.3,
    system,
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

  /*
   * 2. Hard-rule survival. A keyword-level smoke test, not a proof.
   *
   * The test has to know which script it is looking in. It used to extract only
   * [a-z] tokens, which meant that against a Hindi prompt it searched for
   * English words that had been translated away and reported rules as dropped
   * when they were plainly present - the rule "always address the customer as
   * 'गौरव जी'" was flagged missing while both Devanagari fragments were sitting
   * in the prompt. A check that cries wolf on a working prompt is worse than no
   * check, because it trains you to ignore the real ones.
   *
   * So: match on the rule's non-Latin fragments when it has them, and when it
   * has none and the prompt is in another script, say the check could not run
   * rather than pretending it failed.
   */
  const nonLatinFragments = (rule: string) =>
    (rule.match(/[^\p{Script=Latin}\p{P}\p{N}\s]+[^\p{P}\p{N}]*/gu) ?? [])
      .map((f) => f.trim())
      .filter((f) => f.length > 1);

  const latinKeywords = (rule: string) =>
    rule
      .toLowerCase()
      .split(/[^a-z']+/)
      .filter((w) => w.length > 5 && !STOPWORDS.has(w));

  const translated = !!targetLanguage && targetLanguage.script !== "latin";
  const unverifiable: string[] = [];

  const droppedRules = spec.behavioural_rules.hard_rules.filter((rule) => {
    const fragments = nonLatinFragments(rule);
    if (fragments.length > 0) {
      return !fragments.some((fragment) => prompt.includes(fragment));
    }

    const keywords = latinKeywords(rule);
    if (keywords.length === 0) return false;
    if (keywords.some((word) => lower.includes(word))) return false;

    // English rule, non-Latin prompt: the words were translated, so their
    // absence proves nothing either way.
    if (translated) {
      unverifiable.push(rule);
      return false;
    }
    return true;
  });

  if (droppedRules.length > 0) {
    warnings.push(
      `${droppedRules.length} hard rule(s) may not have reached the prompt: ` +
        droppedRules.map((r) => `"${r}"`).join("; ")
    );
  }
  if (unverifiable.length > 0) {
    warnings.push(
      `${unverifiable.length} hard rule(s) could not be checked by keyword ` +
        `because the prompt was written in ${targetLanguage!.label} while the ` +
        "rule is in English. Read them in the prompt to confirm: " +
        unverifiable.map((r) => `"${r}"`).join("; ")
    );
  }

  // 3. Length sanity in both directions.
  /*
   * 2b. Did the persona's own voice actually reach the prompt?
   *
   * Both checks below exist because the previous version passed every other
   * test while producing a generic agent. Structure, length and hard rules were
   * all fine; what was missing was the persona's own words, and nothing was
   * looking for them.
   */
  const survivingPhrases = spec.evidence.signature_phrases.filter((phrase) =>
    prompt.includes(phrase)
  );
  if (
    spec.evidence.signature_phrases.length > 0 &&
    survivingPhrases.length < spec.evidence.signature_phrases.length
  ) {
    warnings.push(
      `Only ${survivingPhrases.length} of ` +
        `${spec.evidence.signature_phrases.length} signature phrases survived ` +
        "verbatim into the prompt. These are the persona's own words; without " +
        "them the agent falls back on generic phrasing."
    );
  }

  if (targetLanguage && targetLanguage.script !== "latin") {
    // A prompt that is supposed to be in Hindi but comes back in Latin script
    // is the exact failure this change was made to prevent, so it is checked
    // rather than assumed.
    const signals = readTextSignals(prompt);
    if (signals.indicScriptRatio < 0.3) {
      warnings.push(
        `The prompt was meant to be written in ${targetLanguage.label} but is ` +
          `only ${Math.round(signals.indicScriptRatio * 100)}% ` +
          `${targetLanguage.script} script. The agent will likely sound like a ` +
          "translation rather than like the source speaker. Re-run the stage."
      );
    }
  }

  if (targetLanguage && language?.code_mixed) {
    const signals = readTextSignals(prompt);
    if (signals.latinTokenRatio < 0.05) {
      warnings.push(
        "The source call was code-mixed but the generated prompt contains " +
          "almost no English. The agent will speak in a purer register than " +
          "the person it is modelled on."
      );
    }
  }

  const words = prompt.split(/\s+/).filter(Boolean).length;
  if (words < 250) {
    warnings.push(
      `The prompt is only ${words} words, which is thin for nine sections. ` +
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

  // 5. The idle lines are spoken into a silence, so length is the whole point.
  //    A long one talks over someone who was about to answer.
  const idleMessages = generated.idle_messages.map((m) => m.trim()).filter(Boolean);
  const longIdle = idleMessages.filter(
    (m) => m.split(/\s+/).filter(Boolean).length > 10
  );
  if (longIdle.length > 0) {
    warnings.push(
      `${longIdle.length} idle line(s) are longer than ten words. They are ` +
        "spoken into a pause, so a long one talks over the person just as they " +
        `start answering: ${longIdle.map((m) => `"${m}"`).join("; ")}`
    );
  }

  return {
    systemPrompt: prompt,
    firstMessage: generated.first_message.trim(),
    idleMessages,
    warnings,
  };
}
