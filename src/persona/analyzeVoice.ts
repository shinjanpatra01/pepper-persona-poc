import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { completeAudioJson } from "../lib/llm.js";
import type { ProsodyFeatures } from "../transcription/prosody.js";
import { VoiceProfileSchema, type VoiceProfile } from "../types.js";

const run = promisify(execFile);

/** Total seconds of agent speech to send. Enough to judge, small enough to be cheap. */
const SAMPLE_SECONDS = 45;
/** Ignore very short segments - back-channels carry no useful voice signal. */
const MIN_SEGMENT_SECONDS = 1.5;

/**
 * Cut an audio sample containing ONLY the agent.
 *
 * This is the part that makes the whole step work. Handing the model the raw
 * recording would have it describe a blend of two people, and on a two-man
 * sales call that average is worse than useless. So we take the agent's
 * longest segments, concatenate them, and downmix to 16 kHz mono - which also
 * shrinks the request enough to send inline.
 */
async function cutAgentSample(
  audioPath: string,
  segments: { start: number; end: number }[]
): Promise<string> {
  const usable = segments
    .filter((s) => s.end - s.start >= MIN_SEGMENT_SECONDS)
    .sort((a, b) => b.end - b.start - (a.end - a.start));

  if (usable.length === 0) {
    throw new Error(
      "No agent speech segment is long enough to analyse. The recording may be " +
        "too short, or diarisation may have failed."
    );
  }

  // Take longest-first until we have enough, then restore chronological order
  // so the sample still sounds like a conversation rather than a jump cut reel.
  const chosen: { start: number; end: number }[] = [];
  let total = 0;
  for (const segment of usable) {
    if (total >= SAMPLE_SECONDS) break;
    chosen.push(segment);
    total += segment.end - segment.start;
  }
  chosen.sort((a, b) => a.start - b.start);

  const outputPath = join(tmpdir(), `pepper-voice-${process.pid}.mp3`);

  // One ffmpeg pass: trim each segment, concatenate, downmix.
  const filters = chosen
    .map(
      (s, i) =>
        `[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS[a${i}]`
    )
    .join(";");
  const inputs = chosen.map((_, i) => `[a${i}]`).join("");
  const filterComplex = `${filters};${inputs}concat=n=${chosen.length}:v=0:a=1[out]`;

  await run("ffmpeg", [
    "-y",
    "-loglevel", "error",
    "-i", audioPath,
    "-filter_complex", filterComplex,
    "-map", "[out]",
    "-ac", "1",
    "-ar", "16000",
    outputPath,
  ]);

  return outputPath;
}

const SYSTEM_PROMPT = `
You are a voice casting director. You will hear a montage of one speaker taken
from a phone call - the professional running the call. Your job is to describe
their VOICE precisely enough that someone could pick a matching text-to-speech
voice and delivery settings.

Describe only what you can hear:
  - perceived gender and pitch of the voice
  - accent and regional character, as specifically as you can honestly place it
  - timbre: bright, warm, nasal, gravelly, breathy, resonant
  - pace and rhythm, and how they use pauses
  - emotional register: what this voice makes a listener feel

The audio is a montage. Ignore the abrupt joins between segments, and never
comment on the content of what is said - only on how it sounds.

accent_code must be your single best mapping to a broad regional variety. Use
"other" only when the speaker is clearly none of the listed varieties, not when
you are merely unsure.

delivery_notes should list habits a speech synthesiser could plausibly imitate,
such as rising intonation on questions, clipped sentence endings, or stressing
the first word of a sentence. Do not list things a synthesiser cannot do.

audio_only_observations must contain things a written transcript could not have
revealed. This list is the evidence for whether listening to the audio was
worth it at all, so be strict: if something is obvious from the words alone, it
does not belong here.

Set confidence to low when the audio is noisy, brief, or the accent is mixed.
`.trim();

export async function analyzeVoice(input: {
  audioPath: string;
  prosody: ProsodyFeatures;
}): Promise<VoiceProfile> {
  const samplePath = await cutAgentSample(input.audioPath, input.prosody.segments);

  try {
    const audio = await readFile(samplePath);

    // The measured numbers go in as context so the model's impression of pace
    // is anchored to arithmetic rather than vibes.
    const context =
      `Measured from the same speaker's timings:\n` +
      `  speaking rate: ${input.prosody.words_per_minute} words per minute\n` +
      `  mean pause between words: ${input.prosody.mean_intra_turn_pause}s\n` +
      `  deliberate pauses (>0.4s): ${input.prosody.long_pauses_per_100_words} per 100 words\n` +
      `  mean delay before replying: ${input.prosody.mean_response_latency}s\n\n` +
      `For reference, conversational English averages roughly 150 words per ` +
      `minute. Let these numbers correct your impression of pace if they ` +
      `disagree with it.\n\nDescribe this speaker's voice.`;

    return await completeAudioJson({
      schema: VoiceProfileSchema,
      schemaName: "voice_profile",
      system: SYSTEM_PROMPT,
      user: context,
      audioBase64: audio.toString("base64"),
      audioFormat: "mp3",
    });
  } finally {
    await rm(samplePath, { force: true });
  }
}
