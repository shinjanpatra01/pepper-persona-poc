/**
 * One table describing every language this pipeline knows how to route.
 *
 * Detection produces a language code; three downstream decisions consume it -
 * which offline STT transcribes the source recording, which realtime STT the
 * live Vapi agent listens with, and which TTS voice it answers in. Keeping all
 * three in a single row per language is the point: adding Assamese later is one
 * entry, not four edits scattered across the codebase, and a language with no
 * Deepgram support cannot silently be routed to Deepgram.
 */

export type ScriptName =
  | "latin"
  | "devanagari"
  | "bengali"
  | "gurmukhi"
  | "gujarati"
  | "odia"
  | "tamil"
  | "telugu"
  | "kannada"
  | "malayalam"
  | "arabic"
  | "mixed"
  | "unknown";

export interface LanguageRow {
  /** ISO 639-1 primary code, our canonical key. */
  code: string;
  label: string;
  /** True for the Indian subcontinent varieties this layer exists to rescue. */
  indian: boolean;
  /** Native script. Latin here means the language is normally romanised. */
  script: ScriptName;
  /** BCP-47 tag Sarvam accepts, or null when Sarvam does not cover it. */
  sarvam: string | null;
  /**
   * Deepgram language parameter, or null when Deepgram has no model for it.
   * A null here is exactly why the Indian-language path exists: nova-3 English
   * will happily return confident nonsense rather than an error.
   */
  deepgram: string | null;
  /** Azure locale, used for both the Vapi transcriber and the TTS voice. */
  azureLocale: string;
  azureVoices: { male: string; female: string };
  /**
   * Words per minute this locale's Azure voices deliver at 1.0x.
   *
   * This has to be per LANGUAGE, not just per gender. The measured rate we
   * divide by it is a word COUNT, and languages do not put the same number of
   * words in a minute of speech - Hindi carries more syllables per word, so the
   * same subjective pace yields a lower count than English. Dividing a Hindi
   * count by an English baseline is a units error: it made a speaker the voice
   * analyser independently heard as "fast" come out at 0.92x, i.e. slower than
   * the voice's own default.
   *
   * Calibration anchor: a speaker the voice analyser independently describes as
   * "moderate" should come out at roughly 1.0x. hi-IN is set from a real call
   * that measured 154 wpm and was heard as moderate, which puts the male
   * baseline at ~155. The other locales are scaled estimates and have NOT been
   * checked against a recording - treat them as starting points and adjust by
   * ear with VOICE_BASELINE_WPM_<LOCALE>_<SEX>, e.g.
   * VOICE_BASELINE_WPM_TA_IN_MALE=140.
   */
  baselineWpm: { male: number; female: number };
}

export const LANGUAGES: LanguageRow[] = [
  // --- the non-Indian varieties the POC already handled ---
  { code: "en", label: "English", indian: false, script: "latin",
    sarvam: "en-IN", deepgram: "en", azureLocale: "en-US",
    azureVoices: { male: "en-US-AndrewNeural", female: "en-US-AriaNeural" },
    baselineWpm: { male: 200, female: 155 } },

  // --- Indian English: same language, different acoustic model ---
  { code: "en-IN", label: "Indian English", indian: true, script: "latin",
    sarvam: "en-IN", deepgram: "en-IN", azureLocale: "en-IN",
    azureVoices: { male: "en-IN-PrabhatNeural", female: "en-IN-NeerjaNeural" },
    baselineWpm: { male: 185, female: 150 } },

  // --- Indian languages ---
  // hi-Latn is Deepgram's romanised-Hindi model and the single most useful
  // entry in this table: it is what actually reads Hinglish, where the words
  // are Hindi but the speaker mixes English clauses in freely.
  { code: "hi", label: "Hindi", indian: true, script: "devanagari",
    sarvam: "hi-IN", deepgram: "hi", azureLocale: "hi-IN",
    azureVoices: { male: "hi-IN-MadhurNeural", female: "hi-IN-SwaraNeural" },
    baselineWpm: { male: 155, female: 145 } },
  { code: "hi-Latn", label: "Hinglish (romanised Hindi)", indian: true, script: "latin",
    sarvam: "hi-IN", deepgram: "hi-Latn", azureLocale: "hi-IN",
    azureVoices: { male: "hi-IN-MadhurNeural", female: "hi-IN-SwaraNeural" },
    baselineWpm: { male: 155, female: 145 } },
  { code: "bn", label: "Bengali", indian: true, script: "bengali",
    sarvam: "bn-IN", deepgram: null, azureLocale: "bn-IN",
    azureVoices: { male: "bn-IN-BashkarNeural", female: "bn-IN-TanishaaNeural" },
    baselineWpm: { male: 160, female: 145 } },
  { code: "ta", label: "Tamil", indian: true, script: "tamil",
    sarvam: "ta-IN", deepgram: "ta", azureLocale: "ta-IN",
    azureVoices: { male: "ta-IN-ValluvarNeural", female: "ta-IN-PallaviNeural" },
    baselineWpm: { male: 150, female: 135 } },
  { code: "te", label: "Telugu", indian: true, script: "telugu",
    sarvam: "te-IN", deepgram: null, azureLocale: "te-IN",
    azureVoices: { male: "te-IN-MohanNeural", female: "te-IN-ShrutiNeural" },
    baselineWpm: { male: 150, female: 135 } },
  { code: "mr", label: "Marathi", indian: true, script: "devanagari",
    sarvam: "mr-IN", deepgram: null, azureLocale: "mr-IN",
    azureVoices: { male: "mr-IN-ManoharNeural", female: "mr-IN-AarohiNeural" },
    baselineWpm: { male: 165, female: 150 } },
  { code: "gu", label: "Gujarati", indian: true, script: "gujarati",
    sarvam: "gu-IN", deepgram: null, azureLocale: "gu-IN",
    azureVoices: { male: "gu-IN-NiranjanNeural", female: "gu-IN-DhwaniNeural" },
    baselineWpm: { male: 165, female: 150 } },
  { code: "kn", label: "Kannada", indian: true, script: "kannada",
    sarvam: "kn-IN", deepgram: "kn", azureLocale: "kn-IN",
    azureVoices: { male: "kn-IN-GaganNeural", female: "kn-IN-SapnaNeural" },
    baselineWpm: { male: 150, female: 135 } },
  { code: "ml", label: "Malayalam", indian: true, script: "malayalam",
    sarvam: "ml-IN", deepgram: null, azureLocale: "ml-IN",
    azureVoices: { male: "ml-IN-MidhunNeural", female: "ml-IN-SobhanaNeural" },
    baselineWpm: { male: 145, female: 130 } },
  { code: "pa", label: "Punjabi", indian: true, script: "gurmukhi",
    sarvam: "pa-IN", deepgram: null, azureLocale: "pa-IN",
    azureVoices: { male: "pa-IN-OjasNeural", female: "pa-IN-VaaniNeural" },
    baselineWpm: { male: 170, female: 155 } },
  { code: "or", label: "Odia", indian: true, script: "odia",
    sarvam: "od-IN", deepgram: null, azureLocale: "or-IN",
    azureVoices: { male: "or-IN-SukantNeural", female: "or-IN-SubhasiniNeural" },
    baselineWpm: { male: 160, female: 145 } },
  { code: "ur", label: "Urdu", indian: true, script: "arabic",
    sarvam: "ur-IN", deepgram: "ur", azureLocale: "ur-IN",
    azureVoices: { male: "ur-IN-SalmanNeural", female: "ur-IN-GulNeural" },
    baselineWpm: { male: 170, female: 155 } },
];

const BY_CODE = new Map(LANGUAGES.map((row) => [row.code, row]));

export function lookupLanguage(code: string): LanguageRow | undefined {
  return BY_CODE.get(code);
}

/** Resolve whatever a detector returned ("hi-IN", "hin", "HI") to our key. */
export function normaliseLanguageCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value || value.toLowerCase() === "unknown") return null;

  // Sarvam and Azure speak BCP-47; Deepgram mixes bare codes with tagged ones.
  // en-IN and hi-Latn are meaningful distinctions we keep; every other region
  // tag collapses to the base language, since our table is keyed that way.
  const exact = BY_CODE.get(value) ?? BY_CODE.get(value.toLowerCase());
  if (exact) return exact.code;

  const lower = value.toLowerCase();
  if (lower === "en-in") return "en-IN";
  if (lower === "hi-latn" || lower === "hi-latin") return "hi-Latn";
  if (lower === "od-in" || lower === "or-in") return "or";

  const base = lower.split(/[-_]/)[0]!;
  return BY_CODE.has(base) ? base : null;
}

/** Unicode block per script, used to read a language straight off a transcript. */
export const SCRIPT_RANGES: { script: ScriptName; pattern: RegExp; language: string }[] = [
  { script: "devanagari", pattern: /[ऀ-ॿ]/g, language: "hi" },
  { script: "bengali", pattern: /[ঀ-৿]/g, language: "bn" },
  { script: "gurmukhi", pattern: /[਀-੿]/g, language: "pa" },
  { script: "gujarati", pattern: /[઀-૿]/g, language: "gu" },
  { script: "odia", pattern: /[଀-୿]/g, language: "or" },
  { script: "tamil", pattern: /[஀-௿]/g, language: "ta" },
  { script: "telugu", pattern: /[ఀ-౿]/g, language: "te" },
  { script: "kannada", pattern: /[ಀ-೿]/g, language: "kn" },
  { script: "malayalam", pattern: /[ഀ-ൿ]/g, language: "ml" },
  { script: "arabic", pattern: /[؀-ۿ]/g, language: "ur" },
];
