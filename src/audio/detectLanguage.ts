import { z } from "zod";
import { completeAudioJson } from "../lib/llm.js";
import { probeWithDeepgram } from "../transcription/deepgram.js";
import { hasSarvam, sarvamTranscribe } from "../transcription/sarvam.js";
import { lookupLanguage, normaliseLanguageCode, type LanguageRow } from "./languages.js";
import { cutProbeSample } from "./sample.js";
import { looksHinglish, looksScriptMixed, readTextSignals } from "./textSignals.js";
import type { AudioLanguageProfile, LanguageSignal } from "../types.js";

/**
 * The input-audio detection layer.
 *
 * Everything downstream - which STT reads the recording, which STT the live
 * agent listens with, which TTS voice it answers in - hangs off one decision:
 * what language and variety is this? Getting it wrong is not a degraded result,
 * it is a garbage one, so the decision is made from several independent
 * signals rather than one, and the evidence is kept alongside the verdict so a
 * wrong call can be seen and overridden rather than merely suffered.
 *
 * Four signals, cheapest and most specific first:
 *
 *   1. Sarvam STT with language_code=unknown. Purpose-built for the 11 Indian
 *      varieties, returns a probability, and hands back a transcript in the
 *      native script for free. This is the authority when it is confident.
 *   2. Deepgram detect_language. Broad but Western-leaning; its real value is
 *      the WORD confidence it reports, which collapses when an English model
 *      is pointed at non-English audio even though the language guess stays
 *      "en". That collapse is the tell.
 *   3. Script and lexicon signals over both transcripts. Free, and the only
 *      thing that can identify Hinglish - code-mixed speech is not a language
 *      any identifier will name, so it has to be read off the words.
 *   4. A multimodal LLM listening to the sample. Slowest, used only to break a
 *      tie or when the first two are unavailable, but it is the one detector
 *      that hears accent rather than transcribing words, so it is what catches
 *      Indian-accented English that every other signal calls plain "en".
 *
 * All four are advisory. A caller-supplied language always wins.
 */

const LlmVerdictSchema = z.object({
  primary_language: z.string(),
  is_indian_speaker: z.boolean(),
  accent: z.string(),
  code_mixed_with_english: z.boolean(),
  confidence: z.enum(["low", "medium", "high"]),
  reasoning: z.string(),
});

/**
 * Below this, Deepgram's own words are not to be trusted. Clean English phone
 * audio comes back around 0.95; the same model on Hindi lands far under, which
 * is what makes this a usable "wrong model" alarm rather than a noise gauge.
 */
const DEEPGRAM_CONFIDENCE_FLOOR = 0.72;

/** Sarvam probability above which we stop arguing with it. */
const SARVAM_TRUST = 0.6;

export interface DetectOptions {
  audioPath: string;
  /** Skip detection entirely and use this language. Operator override. */
  forceLanguage?: string;
  /** Ask the multimodal model even when the cheap signals already agree. */
  alwaysUseLlm?: boolean;
}

async function sarvamSignal(
  sample: Buffer
): Promise<{ signal: LanguageSignal; transcript: string } | null> {
  if (!hasSarvam()) return null;
  try {
    // codemix keeps English words as English instead of transliterating them,
    // which is what makes the transcript readable as evidence of Hinglish.
    const result = await sarvamTranscribe(sample, {
      languageCode: "unknown",
      mode: "codemix",
      filename: "probe.wav",
    });
    // Sarvam's inventory is the Indian languages plus English, so "en-IN" from
    // it means "this is English", NOT "this is Indian English" - it has no
    // en-US to contrast against. Reading it literally marked every American
    // call as Indian. Collapse it to plain English and let the accent question
    // be settled by a detector that can actually hear an accent.
    const raw = normaliseLanguageCode(result.languageCode);
    const language = raw === "en-IN" ? "en" : raw;

    return {
      signal: {
        source: "sarvam-lid",
        language,
        confidence: result.languageProbability ?? 0.5,
        detail:
          `Sarvam identified ${result.languageCode ?? "nothing"}` +
          (result.languageProbability !== null
            ? ` at p=${result.languageProbability.toFixed(2)}`
            : " (no probability returned)") +
          (raw === "en-IN"
            ? '. Read as plain English: Sarvam has no non-Indian English to ' +
              "contrast against, so its en-IN cannot distinguish accents."
            : ""),
      },
      transcript: result.transcript,
    };
  } catch (error) {
    return {
      signal: {
        source: "sarvam-lid",
        language: null,
        confidence: 0,
        detail: `Sarvam probe failed: ${(error as Error).message}`,
      },
      transcript: "",
    };
  }
}

async function deepgramSignal(
  sample: Buffer
): Promise<{ signal: LanguageSignal; transcript: string; wordConfidence: number }> {
  try {
    const probe = await probeWithDeepgram(sample);
    return {
      signal: {
        source: "deepgram-lid",
        language: normaliseLanguageCode(probe.detectedLanguage),
        confidence: probe.languageConfidence ?? 0.5,
        detail:
          `Deepgram detected ${probe.detectedLanguage ?? "nothing"}; ` +
          `word confidence ${probe.transcriptConfidence.toFixed(2)}` +
          (probe.transcriptConfidence < DEEPGRAM_CONFIDENCE_FLOOR
            ? " - below the floor, so its English reading is unreliable."
            : "."),
      },
      transcript: probe.transcript,
      wordConfidence: probe.transcriptConfidence,
    };
  } catch (error) {
    return {
      signal: {
        source: "deepgram-lid",
        language: null,
        confidence: 0,
        detail: `Deepgram probe failed: ${(error as Error).message}`,
      },
      transcript: "",
      wordConfidence: 0,
    };
  }
}

async function llmSignal(sample: Buffer): Promise<LanguageSignal> {
  try {
    const verdict = await completeAudioJson({
      schema: LlmVerdictSchema,
      schemaName: "language_verdict",
      system:
        "You are a language identification expert listening to a montage of " +
        "short excerpts from one phone call. Report the primary language " +
        "actually spoken, using an ISO 639-1 code (hi, en, ta, te, bn, mr, gu, " +
        "kn, ml, pa, or, ur).\n\n" +
        "The call has two speakers and they may not share an accent. Judge the " +
        "call as a whole, and set is_indian_speaker only if the speech is " +
        "PREDOMINANTLY Indian-accented - not because one of the two voices is. " +
        "If the two speakers differ, say so in your reasoning and lower your " +
        "confidence. Ignore the abrupt joins between excerpts.\n\n" +
        "Two distinctions matter more than the rest:\n" +
        "  - Indian-accented ENGLISH is English. Report 'en' and set " +
        "is_indian_speaker true. Do not report 'hi' merely because the speaker " +
        "sounds Indian.\n" +
        "  - Speech that is grammatically Hindi with English words dropped in " +
        "is Hindi. Report 'hi' and set code_mixed_with_english true.\n\n" +
        "Judge only what you hear. Set confidence low if the sample is noisy, " +
        "very short, or you are genuinely torn.",
      user:
        "Identify the language, the speaker's regional accent, and whether the " +
        "speech mixes English into another language.",
      audioBase64: sample.toString("base64"),
      audioFormat: "wav",
    });

    return {
      source: "llm-audio",
      language: normaliseLanguageCode(verdict.primary_language),
      confidence:
        verdict.confidence === "high" ? 0.85 : verdict.confidence === "medium" ? 0.6 : 0.35,
      detail:
        `Model heard ${verdict.primary_language} (${verdict.accent})` +
        (verdict.code_mixed_with_english ? ", code-mixed with English" : "") +
        `. ${verdict.reasoning}`,
      indianSpeaker: verdict.is_indian_speaker,
      codeMixed: verdict.code_mixed_with_english,
    };
  } catch (error) {
    return {
      source: "llm-audio",
      language: null,
      confidence: 0,
      detail: `Multimodal probe failed: ${(error as Error).message}`,
    };
  }
}

export async function detectAudioLanguage(
  options: DetectOptions
): Promise<AudioLanguageProfile> {
  const notes: string[] = [];

  if (options.forceLanguage) {
    const forced = normaliseLanguageCode(options.forceLanguage);
    const row = forced ? lookupLanguage(forced) : undefined;
    if (!row) {
      throw new Error(
        `Unknown language "${options.forceLanguage}". Supported: ` +
          "en, en-IN, hi, hi-Latn, bn, ta, te, mr, gu, kn, ml, pa, or, ur."
      );
    }
    return {
      language: row.code,
      label: row.label,
      is_indian: row.indian,
      code_mixed: false,
      script: row.script,
      confidence: "high",
      detected_by: "operator override",
      deepgram_word_confidence: null,
      signals: [],
      notes: [`Detection skipped: language forced to ${row.code} by the operator.`],
    };
  }

  // One sample, cut once, handed to every detector. Re-cutting per probe was
  // wasted ffmpeg work and, worse, meant the detectors could disagree because
  // they had heard different audio.
  const probe = await cutProbeSample(options.audioPath);
  let sarvam: Awaited<ReturnType<typeof sarvamSignal>> = null;
  let deepgram: Awaited<ReturnType<typeof deepgramSignal>>;
  try {
    // Independent probes, so they run together - detection is a latency tax on
    // every recording and there is no reason to pay it twice.
    [sarvam, deepgram] = await Promise.all([
      sarvamSignal(probe.bytes),
      deepgramSignal(probe.bytes),
    ]);
  } catch (error) {
    await probe.cleanup();
    throw error;
  }

  if (!sarvam) {
    notes.push(
      "No SARVAM_API_KEY set, so the Indian-language identifier was skipped. " +
        "Detection is running on Deepgram and text signals alone, which is " +
        "materially weaker for Hindi and the regional languages."
    );
  }

  const signals: LanguageSignal[] = [];
  if (sarvam) signals.push(sarvam.signal);
  signals.push(deepgram.signal);

  // Text evidence, read from whichever transcripts the probes produced. Sarvam
  // gives us native script; Deepgram gives us the romanised reading, which is
  // where Hinglish shows up.
  const sarvamText = readTextSignals(sarvam?.transcript ?? "");
  const deepgramText = readTextSignals(deepgram.transcript);
  // Two independent shapes of the same phenomenon: romanised Hindi in a Latin
  // transcript, and English words surviving in Latin inside a Devanagari one.
  const hinglish = looksHinglish(sarvamText) || looksHinglish(deepgramText);
  const scriptMixed = looksScriptMixed(sarvamText);
  const scriptLanguage = sarvamText.scriptLanguage;

  signals.push({
    source: "text-signals",
    language: scriptLanguage,
    confidence: scriptLanguage ? 0.7 : hinglish ? 0.5 : 0.2,
    detail:
      `Script: ${sarvamText.script} (${Math.round(sarvamText.indicScriptRatio * 100)}% Indic, ` +
      `${Math.round(sarvamText.latinTokenRatio * 100)}% Latin words). ` +
      `Romanised Hindi markers: ${Math.round(
        Math.max(sarvamText.hinglishRatio, deepgramText.hinglishRatio) * 100
      )}% of tokens` +
      (hinglish
        ? ` (${[...new Set([...sarvamText.hinglishHits, ...deepgramText.hinglishHits])]
            .slice(0, 8)
            .join(", ")}).`
        : "."),
  });

  const sarvamConfident =
    !!sarvam?.signal.language && sarvam.signal.confidence >= SARVAM_TRUST;
  const deepgramShaky = deepgram.wordConfidence < DEEPGRAM_CONFIDENCE_FLOOR;
  const disagree =
    !!sarvam?.signal.language &&
    !!deepgram.signal.language &&
    sarvam.signal.language !== deepgram.signal.language;

  // What the cheap signals alone would conclude. Needed before deciding whether
  // to pay for the multimodal probe, because the strongest reason to run it is
  // that they landed on plain English - see below.
  const provisional =
    (sarvamConfident && sarvam!.signal.language !== "en"
      ? sarvam!.signal.language
      : null) ??
    scriptLanguage ??
    sarvam?.signal.language ??
    deepgram.signal.language ??
    null;

  /*
   * The multimodal pass is the expensive one, so it is earned rather than
   * routine. Three cases earn it:
   *
   *   - the cheap signals conflict, or none of them could name a language;
   *   - Deepgram's word confidence collapsed, which means its English reading
   *     is not to be trusted whatever it claims the language is;
   *   - the answer came back "English". This is the important one and it is
   *     not an edge case: no identifier in the stack can tell Indian English
   *     from American English. Deepgram reports a coarse "en", and Sarvam has
   *     no non-Indian English to contrast against. An accent is audible and
   *     not transcribable, so the only detector that can settle it is one that
   *     listens. Skip this and every Indian-accented English call is routed to
   *     a US acoustic model and answered in a US voice - which is most of what
   *     "Deepgram fails on Indian accents" actually means in practice.
   */
  const englishUnresolved = !provisional || provisional === "en";
  const needLlm =
    options.alwaysUseLlm ||
    englishUnresolved ||
    (!sarvamConfident && (disagree || deepgramShaky));

  let llm: LanguageSignal | null = null;
  try {
    if (needLlm) {
      llm = await llmSignal(probe.bytes);
      signals.push(llm);
    }
  } finally {
    await probe.cleanup();
  }

  notes.push(
    `Sampled ${probe.windows.length} window(s) of ${Math.round(
      probe.windows[0]?.duration ?? 0
    )}s at ${probe.windows.map((w) => Math.round(w.start) + "s").join(", ")}.`
  );

  // --- fusion -------------------------------------------------------------
  let language: string | null = null;
  let detectedBy = "";

  if (sarvamConfident && sarvam!.signal.language !== "en") {
    // Sarvam saying a specific Indian language with real probability is the
    // strongest evidence available; nothing else in the stack is trained on it.
    language = sarvam!.signal.language;
    detectedBy = "Sarvam language identification";
  } else if (scriptLanguage) {
    // Native script in a transcript is not an opinion.
    language = scriptLanguage;
    detectedBy = "native script in the probe transcript";
  } else if (llm?.language && llm.confidence >= 0.6) {
    language = llm.language;
    detectedBy = "multimodal audio analysis";
  } else if (sarvam?.signal.language) {
    language = sarvam.signal.language;
    detectedBy = "Sarvam language identification (low confidence)";
  } else if (deepgram.signal.language) {
    language = deepgram.signal.language;
    detectedBy = "Deepgram language detection";
  } else {
    language = "en";
    detectedBy = "fallback";
    notes.push(
      "Every detector declined to name a language. Falling back to English; " +
        "rerun with --language=<code> if that is wrong."
    );
  }

  // Hinglish is a routing decision, not a detection: the audio is Hindi, but
  // romanised output reads better and the hi-Latn model is what produces it.
  const codeMixed = hinglish || scriptMixed || llm?.codeMixed === true;
  if (language === "hi" && hinglish && !scriptLanguage) {
    language = "hi-Latn";
    notes.push(
      "Heavy English mixing with no Devanagari in the sample: routed to the " +
        "romanised Hindi (Hinglish) models rather than pure Hindi."
    );
  }

  // Indian-accented English is its own row. Nothing above will produce it -
  // every identifier just says "en" - so it is inferred here from the accent
  // judgement and from Deepgram's confidence sagging on otherwise clean audio.
  if (language === "en") {
    const indianAccent = llm?.indianSpeaker === true;
    if (indianAccent || codeMixed || (deepgramShaky && sarvam?.signal.language === "en")) {
      language = "en-IN";
      detectedBy += indianAccent ? " + Indian accent" : " + weak English confidence";
      notes.push(
        "Language is English but the speaker reads as Indian, so the " +
          "Indian-English acoustic model and voice are used instead of US English."
      );
    }
  }

  const row = lookupLanguage(language ?? "en") ?? lookupLanguage("en")!;

  const agreeing = signals.filter(
    (s) => s.language && (s.language === row.code || s.language === language)
  ).length;
  const confidence: AudioLanguageProfile["confidence"] =
    sarvamConfident || scriptLanguage || agreeing >= 2
      ? "high"
      : agreeing === 1
        ? "medium"
        : "low";

  if (confidence === "low") {
    notes.push(
      "Low confidence: the detectors did not corroborate each other. Check the " +
        "transcript before trusting the persona, and override with --language."
    );
  }
  if (row.indian && !row.deepgram) {
    notes.push(
      `Deepgram has no ${row.label} model, so the source transcript comes from ` +
        "Sarvam and the live agent listens through Azure Speech."
    );
  }

  return {
    language: row.code,
    label: row.label,
    is_indian: row.indian,
    code_mixed: codeMixed,
    script: row.script,
    confidence,
    detected_by: detectedBy,
    deepgram_word_confidence: deepgram.wordConfidence || null,
    signals,
    notes,
  };
}

export { DEEPGRAM_CONFIDENCE_FLOOR };

/**
 * Re-decide code-mixing once the whole transcript exists.
 *
 * Detection has to run before transcription, so it judges from a 27-second
 * probe. That is fine for identifying a language - a language does not change
 * halfway through a call - but code-mixing is a RATIO, and a ratio cannot be
 * estimated from 27 seconds of a four-minute call. On a real Hindi property
 * call the probe windows happened to land on low-English stretches and measured
 * 3% Latin words; the full transcript measured 21.7%. The call was flagged
 * monolingual, so the agent was never told to mix English in, and it answered
 * in textbook Hindi where the source speaker had said "आप किस configuration
 * में interested हैं".
 *
 * Re-measuring on the finished transcript costs nothing and is exact. It only
 * ever turns code-mixing ON: the probe seeing English that the full transcript
 * does not is not a failure mode worth modelling.
 */
export function reviewCodeMixing(
  profile: AudioLanguageProfile,
  fullTranscript: string
): AudioLanguageProfile {
  if (profile.code_mixed) return profile;

  const signals = readTextSignals(fullTranscript);
  const mixed = looksScriptMixed(signals) || looksHinglish(signals);
  if (!mixed) return profile;

  return {
    ...profile,
    code_mixed: true,
    signals: [
      ...profile.signals,
      {
        source: "text-signals-full",
        language: profile.language,
        confidence: 0.8,
        detail:
          `Full transcript: ${Math.round(signals.latinTokenRatio * 100)}% Latin ` +
          `words across ${signals.wordCount} words` +
          (signals.hinglishHits.length
            ? ` (${signals.hinglishHits.slice(0, 6).join(", ")})`
            : "") +
          ". Code-mixing was not visible in the short probe.",
        codeMixed: true,
      },
    ],
    notes: [
      ...profile.notes,
      "Code-mixing was detected from the full transcript rather than the probe. " +
        "The probe sample was not representative of the call's English content.",
    ],
  };
}

export type { LanguageRow };
