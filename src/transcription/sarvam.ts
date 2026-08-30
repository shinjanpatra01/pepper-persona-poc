import { basename } from "node:path";

/**
 * Sarvam AI speech-to-text - the Indian-language half of the transcription
 * layer.
 *
 * Deepgram's English models are excellent and its diarisation is the reason
 * this POC chose it, but they are trained on Western English. On Indian-accented
 * English they degrade; on Hindi, Hinglish and the regional languages they do
 * something worse than fail, which is to return fluent English nonsense with a
 * high confidence score. Sarvam's Saaras models are trained on exactly that
 * material, including code-mixed speech, so this module handles the recordings
 * Deepgram cannot.
 *
 * The two are complements, not alternatives - see ./transcribe.ts, which keeps
 * Deepgram's language-agnostic diarisation and swaps only the words.
 */

const BASE_URL = "https://api.sarvam.ai";

/**
 * The key is read lazily and under both spellings. The .env in this project was
 * written as SERVAM_API_KEY; rather than break a working setup we accept it and
 * treat SARVAM_API_KEY as the documented name going forward.
 */
export function sarvamApiKey(): string | null {
  const key = process.env.SARVAM_API_KEY || process.env.SERVAM_API_KEY;
  return key && key.trim() !== "" ? key.trim() : null;
}

export function hasSarvam(): boolean {
  return sarvamApiKey() !== null;
}

export interface SarvamWord {
  word: string;
  start: number;
  end: number;
}

export interface SarvamTranscription {
  transcript: string;
  /** BCP-47 as Sarvam reports it, e.g. "hi-IN". Null when it did not say. */
  languageCode: string | null;
  /** 0-1, present only when we asked Sarvam to auto-detect. */
  languageProbability: number | null;
  words: SarvamWord[];
}

export interface SarvamOptions {
  /**
   * BCP-47 language, or "unknown" to make Sarvam identify it. "unknown" is
   * what turns this endpoint into a language detector.
   */
  languageCode?: string;
  model?: string;
  /**
   * "transcribe" keeps the spoken language as written. "codemix" is the one
   * that matters for Hinglish: it preserves the English words as English
   * instead of transliterating them into Devanagari.
   */
  mode?: "transcribe" | "translate" | "verbatim" | "translit" | "codemix";
  withTimestamps?: boolean;
  /** Name sent with the upload; only the extension is meaningful to Sarvam. */
  filename?: string;
}

/**
 * Sarvam returns word timings as three parallel arrays, but has been seen to
 * return an array of objects on some models. Accepting both costs six lines and
 * removes a whole class of "worked yesterday" failure.
 */
function readWords(timestamps: unknown): SarvamWord[] {
  if (!timestamps || typeof timestamps !== "object") return [];
  const t = timestamps as Record<string, unknown>;

  const words = t.words;
  if (Array.isArray(words) && words.length > 0 && typeof words[0] === "object") {
    return (words as Record<string, unknown>[]).map((w) => ({
      word: String(w.word ?? ""),
      start: Number(w.start ?? w.start_time_seconds ?? 0),
      end: Number(w.end ?? w.end_time_seconds ?? 0),
    }));
  }

  const starts = t.start_time_seconds;
  const ends = t.end_time_seconds;
  if (!Array.isArray(words) || !Array.isArray(starts) || !Array.isArray(ends)) {
    return [];
  }

  return words.map((word, i) => ({
    word: String(word),
    start: Number(starts[i] ?? 0),
    end: Number(ends[i] ?? starts[i] ?? 0),
  }));
}

export async function sarvamTranscribe(
  audio: Buffer,
  options: SarvamOptions = {}
): Promise<SarvamTranscription> {
  const key = sarvamApiKey();
  if (!key) {
    throw new Error(
      "Missing SARVAM_API_KEY. Add it to your .env file to enable Indian " +
        "language transcription."
    );
  }

  const filename = options.filename ? basename(options.filename) : "audio.wav";
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)]), filename);
  form.append("model", options.model ?? "saaras:v3");
  form.append("language_code", options.languageCode ?? "unknown");
  if (options.mode) form.append("mode", options.mode);
  if (options.withTimestamps) form.append("with_timestamps", "true");

  const response = await fetch(`${BASE_URL}/speech-to-text`, {
    method: "POST",
    headers: { "api-subscription-key": key },
    body: form,
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    throw new Error(`Sarvam speech-to-text failed (${response.status}): ${detail}`);
  }

  const json = (await response.json()) as {
    transcript?: string;
    language_code?: string;
    language_probability?: number;
    timestamps?: unknown;
  };

  return {
    transcript: (json.transcript ?? "").trim(),
    languageCode: json.language_code ?? null,
    languageProbability:
      typeof json.language_probability === "number"
        ? json.language_probability
        : null,
    words: readWords(json.timestamps),
  };
}
