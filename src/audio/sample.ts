import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ProbeSample {
  path: string;
  bytes: Buffer;
  /** Where each window was taken from, for the detection write-up. */
  windows: { start: number; duration: number }[];
  cleanup: () => Promise<void>;
}

/**
 * Cut a short, cheap probe sample spread across a recording.
 *
 * Language identification does not need the whole call - a minute of speech
 * settles it - and every detector we send this to is billed by audio duration.
 *
 * The spread is the part that matters. A single window taken from the opening
 * proved actively misleading: a call has two speakers, the first minute is
 * usually one of them plus ring tone and "hello?", and a probe that lands on
 * the customer reports the customer's accent as the recording's. Three windows
 * across the call see both voices and the settled middle of the conversation,
 * which is where the language actually lives. It is the same reasoning behind
 * the montage in analyzeVoice, applied one stage earlier.
 *
 * 16 kHz mono is what every ASR front end resamples to anyway, so downmixing
 * here costs nothing in accuracy and cuts the upload by an order of magnitude.
 */
export async function cutProbeSample(
  audioPath: string,
  options: { durationSeconds?: number; windows?: number } = {}
): Promise<ProbeSample> {
  // 27s, not 45: Sarvam's synchronous endpoint rejects anything over 30
  // seconds outright, and it is the most important detector in the set. One
  // sample sized for the strictest consumer beats cutting a second one.
  const total = options.durationSeconds ?? 27;
  const outputPath = join(tmpdir(), `pepper-probe-${process.pid}.wav`);
  const length = await audioDurationSeconds(audioPath);

  // Short recording, or duration unknown: take it whole and skip the arithmetic.
  const wanted = options.windows ?? 3;
  const count = length > 0 && length > total * 1.5 ? wanted : 1;

  let windows: { start: number; duration: number }[];
  if (count === 1) {
    windows = [{ start: 0, duration: total }];
  } else {
    // Evenly spaced across the middle 90% - the last few seconds are goodbyes
    // and hang-up noise, and the first few are ring tone.
    const each = total / count;
    const usable = length * 0.9;
    windows = Array.from({ length: count }, (_, i) => ({
      start: Math.max(0, length * 0.05 + (usable / count) * i),
      duration: each,
    }));
  }

  const filters = windows
    .map(
      (w, i) =>
        `[0:a]atrim=start=${w.start.toFixed(2)}:end=${(w.start + w.duration).toFixed(
          2
        )},asetpts=PTS-STARTPTS[a${i}]`
    )
    .join(";");
  const inputs = windows.map((_, i) => `[a${i}]`).join("");

  await run("ffmpeg", [
    "-y",
    "-loglevel", "error",
    "-i", audioPath,
    "-filter_complex",
    `${filters};${inputs}concat=n=${windows.length}:v=0:a=1[out]`,
    "-map", "[out]",
    "-ac", "1",
    "-ar", "16000",
    outputPath,
  ]);

  return {
    path: outputPath,
    bytes: await readFile(outputPath),
    windows,
    cleanup: () => rm(outputPath, { force: true }),
  };
}

/** Duration in seconds, via ffprobe. Returns 0 when it cannot be determined. */
export async function audioDurationSeconds(audioPath: string): Promise<number> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ]);
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) ? seconds : 0;
  } catch {
    return 0;
  }
}
