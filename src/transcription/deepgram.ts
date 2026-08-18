import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { optionalEnv, requireEnv } from "../lib/env.js";

/**
 * One diarised utterance as Deepgram returns it: we know WHAT was said and
 * WHICH voice said it, but not yet WHO that voice is (agent or customer).
 * Mapping speaker numbers to roles happens in ./speakers.ts.
 */
export interface DeepgramUtterance {
  speaker: number;
  transcript: string;
  start: number;
  end: number;
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
  source: string
): Promise<DeepgramUtterance[]> {
  const apiKey = requireEnv("DEEPGRAM_API_KEY");
  const model = optionalEnv("DEEPGRAM_MODEL", "nova-3");

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
    results?: { utterances?: DeepgramUtterance[] };
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
  }));
}
