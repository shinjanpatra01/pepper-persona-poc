import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { optionalEnv, requireEnv } from "../lib/env.js";

/**
 * One diarised utterance as Deepgram returns it: we know WHAT was said and
 * WHICH voice said it, but not yet WHO that voice is (agent or customer).
 * Mapping speaker numbers to roles happens in ./speakers.ts.
 */
export interface DeepgramWord {
  word: string;
  start: number;
  end: number;
}

export interface DeepgramUtterance {
  speaker: number;
  transcript: string;
  start: number;
  end: number;
  /** Per-word timings. These are the raw material for prosody measurement. */
  words: DeepgramWord[];
}

const MIME_BY_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".flac": "audio/flac",
};

/**
 * Send audio to Deepgram and get back speaker-numbered utterances.
 *
 * `source` may be either a local file path or a direct https URL to a media
 * file. A YouTube *page* URL will NOT work - Deepgram needs the raw media, so
 * download such recordings first and pass the local file.
 */
export async function transcribeWithDeepgram(
  source: string,
  options: { language?: string } = {}
): Promise<DeepgramUtterance[]> {
  const apiKey = requireEnv("DEEPGRAM_API_KEY");

  /*
   * nova-3 wherever it has the language, nova-2 only where it does not.
   *
   * This used to read "nova-3 is English-first, so anything else drops to
   * nova-2". That was true once and is not any more: nova-3 has since picked up
   * Hindi and most Indian languages, and it is a generation better at all of
   * them. The one that still matters is hi-Latn - the romanised-Hindi model
   * that reads Hinglish the way a person would write it - which exists only on
   * nova-2, so the Hinglish path is unchanged.
   *
   * Kept as its own list rather than shared with the realtime router: this
   * decides how the SOURCE recording is read, and being wrong here corrupts the
   * persona itself rather than one live call.
   */
  const NOVA3_LANGUAGES = new Set([
    "en", "en-IN", "hi", "bn", "ta", "te", "mr", "gu", "kn", "pa", "ur",
  ]);
  const language = options.language;
  const model =
    language && !NOVA3_LANGUAGES.has(language)
      ? optionalEnv("DEEPGRAM_MULTILINGUAL_MODEL", "nova-2")
      : optionalEnv("DEEPGRAM_MODEL", "nova-3");

  // Query params are where all the behaviour lives:
  //   diarize    - the whole reason we chose Deepgram: label distinct speakers
  //   utterances - group words into turn-sized chunks, which is exactly the
  //                shape our Transcript type wants (one entry per turn)
  //   utt_split  - seconds of silence that end an utterance. Deepgram's 0.8
  //                default is too slow for a brisk call: speakers swap faster
  //                than that, so one utterance ends up holding both voices and
  //                the whole chunk gets a single speaker label. Tightening it
  //                trades a few extra fragments for far fewer mislabels, and
  //                our merge step in transcribe.ts glues the fragments back.
  //   punctuate / smart_format - readable text; the LLM in Phase 3 reads this
  const params = new URLSearchParams({
    model,
    diarize: "true",
    utterances: "true",
    utt_split: optionalEnv("DEEPGRAM_UTT_SPLIT", "0.4"),
    punctuate: "true",
    smart_format: "true",
  });

  if (options.language) params.set("language", options.language);

  const isUrl = /^https?:\/\//i.test(source);
  const headers: Record<string, string> = {
    Authorization: `Token ${apiKey}`,
  };
  let body: BodyInit;

  if (isUrl) {
    // Deepgram fetches the media itself.
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ url: source });
  } else {
    // We upload the raw bytes.
    const audio = await readFile(source);
    headers["Content-Type"] =
      MIME_BY_EXT[extname(source).toLowerCase()] ?? "application/octet-stream";
    body = new Uint8Array(audio);
  }

  const response = await fetch(
    `https://api.deepgram.com/v1/listen?${params.toString()}`,
    { method: "POST", headers, body }
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Deepgram request failed (${response.status}): ${detail}`
    );
  }

  const json = (await response.json()) as {
    results?: { utterances?: (DeepgramUtterance & { words?: DeepgramWord[] })[] };
  };

  const utterances = json.results?.utterances;
  if (!utterances || utterances.length === 0) {
    throw new Error(
      "Deepgram returned no utterances. Check that the audio actually " +
        "contains speech and that the file is not empty or corrupt."
    );
  }

  return utterances.map((u) => ({
    speaker: u.speaker ?? 0,
    transcript: u.transcript.trim(),
    start: u.start,
    end: u.end,
    words: (u.words ?? []).map((w) => ({
      word: w.word,
      start: w.start,
      end: w.end,
    })),
  }));
}

/**
 * What Deepgram thinks the audio is, and how sure it was of the words.
 *
 * The confidence number is the interesting one. Deepgram has no way to say
 * "this is not English"; asked for English it returns English, and on Hindi
 * audio that means confident-sounding nonsense. But its own per-alternative
 * confidence sags when the acoustics do not match the model, so a low score on
 * a clean recording is strong evidence that we pointed the wrong model at it -
 * a signal available on every recording, for free, in the call we already make.
 */
export interface DeepgramProbe {
  detectedLanguage: string | null;
  languageConfidence: number | null;
  /** Deepgram's own confidence in the WORDS, 0-1. */
  transcriptConfidence: number;
  transcript: string;
}

export async function probeWithDeepgram(audio: Buffer): Promise<DeepgramProbe> {
  const apiKey = requireEnv("DEEPGRAM_API_KEY");

  // nova-2 rather than the configured model: detect_language is a nova-2
  // feature, and this call exists to identify the language, not to produce the
  // transcript we keep.
  const params = new URLSearchParams({
    model: "nova-2",
    detect_language: "true",
    punctuate: "true",
  });

  const response = await fetch(
    `https://api.deepgram.com/v1/listen?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "audio/wav",
      },
      body: new Uint8Array(audio),
    }
  );

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Deepgram language probe failed (${response.status}): ${detail}`);
  }

  const json = (await response.json()) as {
    results?: {
      channels?: {
        detected_language?: string;
        language_confidence?: number;
        alternatives?: { transcript?: string; confidence?: number }[];
      }[];
    };
  };

  const channel = json.results?.channels?.[0];
  const alternative = channel?.alternatives?.[0];

  return {
    detectedLanguage: channel?.detected_language ?? null,
    languageConfidence:
      typeof channel?.language_confidence === "number"
        ? channel.language_confidence
        : null,
    transcriptConfidence: alternative?.confidence ?? 0,
    transcript: (alternative?.transcript ?? "").trim(),
  };
}
