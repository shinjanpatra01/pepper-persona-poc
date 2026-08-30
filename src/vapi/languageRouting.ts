import { lookupLanguage, type LanguageRow } from "../audio/languages.js";
import { optionalEnv } from "../lib/env.js";
import type { AudioLanguageProfile } from "../types.js";

/**
 * Turn a detected language into the realtime STT the live agent listens with.
 *
 * This is the second half of the detection layer's job. The first half fixed
 * the SOURCE transcript, so the persona we extract is real. This half fixes the
 * LIVE call, so the agent can actually hear the person it is talking to - a
 * Hindi-speaking persona that transcribes its caller through an English model
 * is deaf in exactly the way that made the source transcript useless.
 *
 * Vapi's default transcriber is English. Left alone, every Indian-language
 * assistant we create would be broken on the first turn, which is why this is
 * the one Vapi default the language layer overrides.
 *
 * Three routes, chosen by what each provider actually supports:
 *
 *   Deepgram  - preferred wherever it has a model, which since nova-3 is nearly
 *               everywhere: en, en-IN, hi, bn, ta, te, mr, gu, kn, pa, ur, and
 *               "multi" for code-switching. Lowest latency of the three.
 *   Azure     - now only ml and or, the two nova-3 still misses.
 *   Google    - last resort, for languages the other two both miss.
 *
 * A fallback plan is attached in every case, because a transcriber outage on a
 * live call is a dead call rather than a degraded one.
 */

export interface TranscriberSelection {
  config: Record<string, unknown>;
  rationale: string[];
}

/**
 * The languages nova-3 actually covers, read from Deepgram's own model list
 * rather than from memory.
 *
 * This exists because the obvious belief - "nova-3 is the English model, nova-2
 * is the multilingual one" - was true when this file was written and is not
 * true now. nova-3 has since picked up Hindi and most of the Indian languages
 * that used to be routed to Azure because Deepgram supposedly had nothing.
 *
 * Two gaps remain and both matter here:
 *   hi-Latn  nova-2 only. It is the sole realtime model that returns romanised
 *            Hindi, so the Hinglish route cannot simply be upgraded.
 *   ml, or   neither model covers them; they still go to Azure.
 */
const NOVA3_LANGUAGES = new Set([
  "en", "en-IN", "hi", "bn", "ta", "te", "mr", "gu", "kn", "pa", "ur",
]);

/** Azure STT locales, so we never route a language Azure cannot hear. */
const AZURE_STT_LOCALES = new Set([
  "en-US", "en-IN", "hi-IN", "bn-IN", "ta-IN", "te-IN", "mr-IN",
  "gu-IN", "kn-IN", "ml-IN", "pa-IN", "ur-IN",
]);

/** Google's language names, for the handful Azure and Deepgram both miss. */
const GOOGLE_NAMES: Record<string, string> = {
  hi: "Hindi",
  "hi-Latn": "Hindi",
  bn: "Bengali",
  en: "English",
  "en-IN": "English",
};

export function selectTranscriber(
  profile: AudioLanguageProfile
): TranscriberSelection {
  const row = lookupLanguage(profile.language) ?? lookupLanguage("en")!;
  const rationale: string[] = [];

  // Code-mixed speech is the case a single-language model handles worst, so it
  // gets Deepgram's multilingual model as the fallback regardless of route:
  // "multi" code-switches within an utterance, which is what Hinglish is.
  const multiFallback = {
    provider: "deepgram",
    model: "nova-3",
    language: "multi",
  };

  /*
   * Code-mixed speech listens through nova-3 "multi" rather than nova-2
   * hi-Latn.
   *
   * The two answer different questions. hi-Latn returns romanised Hindi, which
   * is what the SOURCE transcript should look like - it is readable, and the
   * persona is extracted from it. On a LIVE call nothing reads the transcript
   * except the model, which understands Devanagari perfectly well, so the only
   * thing that matters is hearing the sentence correctly. "multi" code-switches
   * within a single utterance, which is precisely what Hinglish is, and it is a
   * generation newer. hi-Latn stays attached underneath as the fallback.
   */
  const codeMixedPrimary = profile.code_mixed && row.code === "hi-Latn";

  // nova-3 has outgrown the table: several rows carry no deepgram code because
  // nova-2 had no model, while nova-3 does. The set is the authority, not the row.
  const deepgramLanguage = codeMixedPrimary
    ? "multi"
    : (row.deepgram ?? (NOVA3_LANGUAGES.has(row.code) ? row.code : null));

  if (deepgramLanguage) {
    const model =
      codeMixedPrimary || NOVA3_LANGUAGES.has(deepgramLanguage)
        ? optionalEnv("VAPI_TRANSCRIBER_MODEL", "nova-3")
        : "nova-2";

    rationale.push(
      `${row.label} -> Deepgram ${model} at language=${deepgramLanguage}` +
        (codeMixedPrimary
          ? " (multi code-switches inside one utterance, which is what Hinglish is)."
          : ".")
    );

    const fallbacks: Record<string, unknown>[] = [];
    if (codeMixedPrimary) {
      // The romanised model underneath, so a "multi" outage degrades to the
      // route this used to take rather than to English.
      fallbacks.push({ provider: "deepgram", model: "nova-2", language: "hi-Latn" });
    } else if (profile.code_mixed) {
      fallbacks.push(multiFallback);
      rationale.push(
        "Speech is code-mixed, so Deepgram's multilingual model is attached as " +
          "a fallback; it code-switches within a single utterance."
      );
    }
    if (AZURE_STT_LOCALES.has(row.azureLocale)) {
      fallbacks.push({ provider: "azure", language: row.azureLocale });
    }

    return {
      config: {
        provider: "deepgram",
        model,
        language: deepgramLanguage,
        /*
         * smartFormat is on for accuracy, but it earns its place on latency:
         * Vapi waits 0.1s to call the model when a transcript ends in
         * punctuation and 1.5s when it does not, so anything that makes the
         * transcriber punctuate confidently is worth more than it looks.
         */
        smartFormat: true,
        // Prices and flat sizes are the numbers on this call. "pachaasi lakh"
        // as digits is both easier for the model and likelier to be punctuated.
        numerals: true,
        /*
         * Deepgram's own silence timeout before it emits a transcript, which is
         * upstream of everything Vapi then waits for. The default of 10ms is
         * the low-latency setting; 300 is the documented remedy if one-word
         * answers ("haan", "nahi") start going missing.
         */
        endpointing: Number(optionalEnv("VAPI_DEEPGRAM_ENDPOINTING", "10")),
        ...(fallbacks.length
          ? { fallbackPlan: { transcribers: fallbacks } }
          : {}),
      },
      rationale,
    };
  }

  if (AZURE_STT_LOCALES.has(row.azureLocale)) {
    rationale.push(
      `Neither nova-3 nor nova-2 covers ${row.label}, so the agent listens through Azure ` +
        `Speech at ${row.azureLocale}.`
    );
    return {
      config: {
        provider: "azure",
        language: row.azureLocale,
        // Semantic segmentation ends a turn on meaning rather than on a fixed
        // silence window. Indian-language speakers pause mid-sentence often
        // enough that a time-based cut chops turns in half.
        segmentationStrategy: "Semantic",
        fallbackPlan: { transcribers: [multiFallback] },
      },
      rationale,
    };
  }

  const googleName = GOOGLE_NAMES[row.code] ?? "Multilingual";
  rationale.push(
    `Neither Deepgram nor Azure covers ${row.label} in realtime; falling back ` +
      `to Google (${googleName}). Expect lower accuracy - this is a known gap.`
  );
  return {
    config: {
      provider: "google",
      model: "gemini-2.0-flash",
      language: googleName,
      fallbackPlan: { transcribers: [multiFallback] },
    },
    rationale,
  };
}

/**
 * Language-appropriate instructions for the model behind the agent.
 *
 * TTS and STT get the sound right; this gets the WORDS right. Without it a
 * Hinglish persona is transcribed in Hinglish, then answered in textbook
 * English by a model that defaults to it - the accent survives and the register
 * does not, which is the more noticeable failure of the two.
 */
export function languageInstructions(profile: AudioLanguageProfile): string {
  const row = lookupLanguage(profile.language) ?? lookupLanguage("en")!;
  const lines: string[] = [];

  if (row.code === "en") return "";

  if (row.code === "en-IN") {
    lines.push(
      "Speak Indian English. Use the vocabulary and phrasing an Indian " +
        "professional would actually use on this call, not American idiom.",
      "Indian number and date conventions are correct here: lakh and crore " +
        "rather than hundred thousand and ten million."
    );
  } else {
    lines.push(
      `Speak ${row.label}. This is the language the person you are modelled on ` +
        "used, and the caller expects it.",
      `If the caller switches to English or to another language, follow them, ` +
        `then return to ${row.label} once they do.`
    );
  }

  if (profile.code_mixed) {
    lines.push(
      "Mix English in the way the source speaker did: keep English for " +
        "business, product and technical terms, and use " +
        `${row.label} for everything around them. Do not translate a term into ` +
        `${row.label} if the original speaker would have said it in English - ` +
        "over-formal pure-language output is the most common way this sounds wrong."
    );
  }

  return lines.join("\n");
}

export type { LanguageRow };
