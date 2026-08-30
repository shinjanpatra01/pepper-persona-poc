import { SCRIPT_RANGES, type ScriptName } from "./languages.js";

/**
 * Language evidence read straight off a transcript, at zero API cost.
 *
 * These signals answer a question the acoustic detectors cannot: whether the
 * STT we already ran was the RIGHT one. An English-only model handed Hindi
 * audio does not report an error - it returns confident English-shaped
 * gibberish. Scoring its own output for Hindi function words is how we catch
 * that, and it is also the only practical way to spot Hinglish, which is not a
 * language any identifier will name.
 */

/**
 * High-frequency romanised Hindi/Urdu function words.
 *
 * Deliberately function words rather than nouns: they appear in every second
 * sentence regardless of topic, so a short sample is enough. Deliberately NOT
 * containing anything that is also an English word - "the", "do", "is", "us",
 * "main", "so", "he", "me", "din" all collide and would fire this detector on
 * plain English. That constraint costs recall and buys precision, which is the
 * right trade when a false positive routes a perfectly good English call to a
 * Hindi model.
 */
const HINGLISH_MARKERS = new Set([
  "hai", "hain", "haan", "nahi", "nahin", "kya", "kyun", "kyon",
  "aap", "aapka", "aapko", "aapke", "tum", "tumhara", "mera", "meri", "mere",
  "tera", "teri", "hamara", "humara", "apna", "apne", "apni",
  "karo", "karna", "karke", "kiya", "karenge", "karta", "karti", "karte",
  "raha", "rahi", "rahe", "hoga", "hogi", "honge", "hota", "hoti", "hote",
  "tha", "thi", "bhi", "toh", "lekin", "magar", "aur", "kuch", "kuchh",
  "bahut", "thoda", "thodi", "accha", "achha", "acha", "theek", "thik", "sahi",
  "matlab", "samajh", "samjha", "batao", "bataye", "bataiye", "dekho", "dekhiye",
  "suniye", "suno", "chalo", "chaliye", "abhi", "phir", "baad", "pehle",
  "jaldi", "paisa", "paise", "rupaye", "rupay", "bhai", "bhaiya", "didi",
  "kaise", "kaisa", "kaisi", "kahan", "kahaan", "kab", "kitna", "kitne", "kitni",
  "koi", "sab", "sabhi", "yaar", "arre", "arey", "bilkul", "zaroor", "jarur",
  "milega", "milegi", "chahiye", "chaahiye", "hoga", "wala", "wali", "walay",
  "yeh", "woh", "voh", "jaise", "waise", "isliye", "kyunki", "agar", "warna",
  "hum", "hamein", "humein", "mujhe", "tujhe", "unko", "usko", "inko",
  "namaste", "namaskar", "shukriya", "dhanyavaad", "ji",
]);

export interface TextSignals {
  /** Dominant script of the text. */
  script: ScriptName;
  /** Language implied by that script, when it is unambiguous. */
  scriptLanguage: string | null;
  /** Share of letters that belong to a non-Latin Indic/Arabic script, 0-1. */
  indicScriptRatio: number;
  /** Share of Latin-script tokens that are romanised Hindi markers, 0-1. */
  hinglishRatio: number;
  /**
   * Share of word tokens written in Latin script, 0-1.
   *
   * This is the OTHER face of code-mixing, and the one that shows up when the
   * transcript comes back in the native script: Hindi in Devanagari with
   * "policy", "discount" and "WhatsApp" still spelled in Latin is a code-mixed
   * call, even though it contains no romanised Hindi at all. Looking only for
   * romanised markers misses every such recording.
   */
  latinTokenRatio: number;
  /** Marker words actually seen, so a human can audit the verdict. */
  hinglishHits: string[];
  /** Latin-script tokens only - the denominator for hinglishRatio. */
  tokenCount: number;
  /** Every word token in any script - the denominator for latinTokenRatio. */
  wordCount: number;
}

export function readTextSignals(text: string): TextSignals {
  const trimmed = (text ?? "").trim();

  let dominant: ScriptName = "unknown";
  let dominantLanguage: string | null = null;
  let dominantCount = 0;
  let indicTotal = 0;

  for (const range of SCRIPT_RANGES) {
    // Fresh regex per call: a shared /g regex carries lastIndex between calls.
    const count = (trimmed.match(new RegExp(range.pattern.source, "gu")) ?? []).length;
    indicTotal += count;
    if (count > dominantCount) {
      dominantCount = count;
      dominant = range.script;
      dominantLanguage = range.language;
    }
  }

  const latinCount = (trimmed.match(/[A-Za-z]/g) ?? []).length;
  const letters = latinCount + indicTotal;
  const indicScriptRatio = letters === 0 ? 0 : indicTotal / letters;

  const tokens = trimmed
    .toLowerCase()
    .split(/[^a-z']+/)
    .filter((token) => token.length > 1);

  const hinglishHits = tokens.filter((token) => HINGLISH_MARKERS.has(token));
  const hinglishRatio = tokens.length === 0 ? 0 : hinglishHits.length / tokens.length;

  // Count words, not letters: one Devanagari word is many letters, so a letter
  // ratio understates how much English is actually being spoken.
  const allTokens = trimmed.split(/\s+/).filter((t) => /\p{L}/u.test(t));
  const latinTokens = allTokens.filter((t) => /^[A-Za-z][A-Za-z'.-]*$/.test(t));
  const latinTokenRatio =
    allTokens.length === 0 ? 0 : latinTokens.length / allTokens.length;

  // A page of Devanagari with three English words is Hindi, not "mixed"; the
  // 15% floor keeps stray transliteration from renaming the script.
  let script: ScriptName = dominant;
  if (indicScriptRatio < 0.15) script = latinCount > 0 ? "latin" : "unknown";
  else if (indicScriptRatio < 0.7 && latinCount > 0) script = "mixed";

  return {
    script,
    scriptLanguage: indicScriptRatio >= 0.15 ? dominantLanguage : null,
    indicScriptRatio: Math.round(indicScriptRatio * 100) / 100,
    hinglishRatio: Math.round(hinglishRatio * 1000) / 1000,
    latinTokenRatio: Math.round(latinTokenRatio * 100) / 100,
    wordCount: allTokens.length,
    hinglishHits: [...new Set(hinglishHits)].slice(0, 20),
    tokenCount: tokens.length,
  };
}

/**
 * Romanised-Hindi threshold.
 *
 * 3% of tokens sounds low until you notice that "hai", "aap" and "kya" alone
 * carry a real Hinglish sentence, while genuinely English sales calls score
 * zero - the marker list has no English homographs by construction. Requiring a
 * minimum token count stops a two-word fragment from deciding anything.
 */
export function looksHinglish(signals: TextSignals): boolean {
  return signals.tokenCount >= 25 && signals.hinglishRatio >= 0.03;
}

/**
 * Code-mixing detected from script mixture rather than from vocabulary.
 *
 * Requires the text to be substantially Indic AND to carry a real share of
 * Latin words. The 8% floor is there because a pure-Hindi transcript still
 * picks up the odd Latin token from a brand name or a stray numeral, and that
 * is not code-mixing; a genuine Hinglish call runs far higher.
 */
export function looksScriptMixed(signals: TextSignals): boolean {
  return (
    signals.indicScriptRatio >= 0.15 &&
    signals.latinTokenRatio >= 0.08 &&
    signals.tokenCount >= 5
  );
}
