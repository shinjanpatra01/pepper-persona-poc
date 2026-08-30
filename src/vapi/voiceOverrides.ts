import { z } from "zod";
import { optionalEnv } from "../lib/env.js";
import type { VoiceSelection } from "./voiceMapping.js";

/**
 * Everything about the voice that a person can change from the console, and the
 * one place that turns it into a Vapi voice object.
 *
 * The pipeline derives a voice from the recording, but almost every part of
 * that derivation is a guess dressed as a measurement: the gender comes from an
 * analyser's impression, the speed from dividing words-per-minute by a tuning
 * constant, the voice itself from one UUID picked per language and gender out
 * of a nine-hundred-voice catalogue. All of it is a starting point. The only
 * way to know whether a voice sounds like the person on the recording is to
 * hear it say something, so every one of these has to be changeable without a
 * code edit and a re-push.
 *
 * The build function lives here rather than in createAgent because the CLI and
 * the console both write the same object and must not drift: a knob that means
 * one thing on `vapi:create` and another in the browser is worse than no knob.
 */

/*
 * Vapi's accepted values, copied from its OpenAPI schema rather than from
 * Cartesia's docs, because Vapi is what actually validates the payload and it
 * lags the provider. Sending a model Cartesia supports but Vapi does not yet
 * list is a 400 at create time.
 */
export const CARTESIA_MODELS = [
  "sonic-3.5",
  "sonic-3",
  "sonic-2",
  "sonic-english",
  "sonic-multilingual",
  "sonic",
] as const;

export const CARTESIA_LANGUAGES = [
  "ar", "bg", "bn", "cs", "da", "de", "el", "en", "es", "fi", "fr", "gu", "he",
  "hi", "hr", "hu", "id", "it", "ja", "ka", "kn", "ko", "ml", "mr", "ms", "nl",
  "no", "pa", "pl", "pt", "ro", "ru", "sk", "sv", "ta", "te", "th", "tl", "tr",
  "uk", "vi", "zh",
] as const;

/**
 * Emotion is a legacy Sonic control. Cartesia dropped it after sonic-1, so on
 * sonic-2 and later it is accepted and ignored rather than rejected. It is
 * exposed because it costs nothing and still works on the older models, but it
 * is never sent unless someone explicitly sets it - a silently-ignored field in
 * every payload is a false lead the next time the voice sounds wrong.
 */
export const CARTESIA_EMOTIONS = [
  "anger:lowest", "anger:low", "anger:high", "anger:highest",
  "positivity:lowest", "positivity:low", "positivity:high", "positivity:highest",
  "surprise:lowest", "surprise:low", "surprise:high", "surprise:highest",
  "sadness:lowest", "sadness:low", "sadness:high", "sadness:highest",
  "curiosity:lowest", "curiosity:low", "curiosity:high", "curiosity:highest",
] as const;

/** Cartesia's own range for generationConfig.speed. */
export const CARTESIA_SPEED = { min: 0.6, max: 1.5 } as const;
export const CARTESIA_VOLUME = { min: 0.5, max: 2 } as const;

/**
 * Azure keeps a tighter speed range than Cartesia, and for a real reason.
 *
 * Azure's speed is applied to already-rendered audio, so below ~0.9x it is
 * stretching rather than speaking slowly: vowels drag, consonants smear, and it
 * reads as "robot" immediately. Cartesia's speed is a generation parameter -
 * the model actually speaks slower - so it can be trusted further down.
 */
export const AZURE_SPEED = { min: 0.9, max: 1.3 } as const;

export function speedRange(provider: string) {
  return provider === "cartesia" ? CARTESIA_SPEED : AZURE_SPEED;
}

/**
 * A saved console edit. Every field is optional: the file records only what a
 * person actually changed, so anything untouched keeps following the pipeline's
 * derivation instead of being frozen at whatever it happened to be the first
 * time someone opened the page.
 */
export const VoiceOverridesSchema = z
  .object({
    provider: z.enum(["azure", "cartesia"]).optional(),
    voiceId: z.string().min(1).optional(),
    model: z.enum(CARTESIA_MODELS).optional(),
    language: z.enum(CARTESIA_LANGUAGES).optional(),
    speed: z.number().optional(),
    volume: z.number().min(CARTESIA_VOLUME.min).max(CARTESIA_VOLUME.max).optional(),
    /** null clears a previously set emotion; undefined leaves it alone. */
    emotion: z.enum(CARTESIA_EMOTIONS).nullable().optional(),
    /**
     * 0 keeps the voice's native accent, 1 pulls its pronunciation toward the
     * target language. Worth having as a switch because which one sounds right
     * is not predictable: on an Indian-English persona, localisation can either
     * fix the accent or flatten the person.
     */
    accentLocalization: z.union([z.literal(0), z.literal(1)]).optional(),
  })
  .loose();

export type VoiceOverrides = z.infer<typeof VoiceOverridesSchema>;

const clamp = (n: number, lo: number, hi: number) =>
  Math.round(Math.min(hi, Math.max(lo, n)) * 100) / 100;

/**
 * The chunking Vapi applies before handing text to TTS.
 *
 * Without it the synthesiser waits on larger buffers, so the first audio lands
 * later and sentence boundaries fall wherever the buffer happened to end -
 * which is where flat, chopped delivery comes from. Chunking on real
 * punctuation means each chunk is a phrase the voice can put an intonation
 * contour on, and the first one leaves early.
 */
const CHUNK_PLAN = {
  enabled: true,
  minCharacters: 30,
  // Devanagari danda included; Vapi rejects duplicates in this list.
  punctuationBoundaries: [".", "!", "?", ",", "।"],
};

/**
 * Merge the derived voice with the saved edits and produce the Vapi voice
 * object, in the shape that provider actually accepts.
 *
 * The shapes differ in a way that is easy to get wrong: Azure carries speed at
 * the top level, while Cartesia has no top-level speed at all - it lives in
 * generationConfig, and sending it alongside provider "cartesia" is rejected.
 * That difference is the reason this function exists instead of a spread at
 * each call site.
 */
export function buildVoicePayload(
  selection: VoiceSelection,
  overrides: VoiceOverrides = {}
): Record<string, unknown> {
  const provider = overrides.provider ?? selection.provider;
  const voiceId = overrides.voiceId ?? selection.voiceId;
  const range = speedRange(provider);
  const speed = clamp(overrides.speed ?? selection.speed, range.min, range.max);

  if (provider !== "cartesia") {
    return { provider, voiceId, speed, chunkPlan: CHUNK_PLAN };
  }

  const generationConfig: Record<string, unknown> = { speed };
  if (overrides.volume !== undefined) {
    generationConfig.volume = clamp(
      overrides.volume,
      CARTESIA_VOLUME.min,
      CARTESIA_VOLUME.max
    );
  }
  if (overrides.accentLocalization !== undefined) {
    generationConfig.experimental = {
      accentLocalization: overrides.accentLocalization,
    };
  }

  return {
    provider: "cartesia",
    voiceId,
    model: overrides.model ?? selection.model ?? optionalEnv("CARTESIA_MODEL", "sonic-2"),
    ...(overrides.language ?? selection.language
      ? { language: overrides.language ?? selection.language }
      : {}),
    chunkPlan: CHUNK_PLAN,
    generationConfig,
    /*
     * Sent as an array even though Vapi's schema types this field as a string.
     * The schema is wrong and its own example gives it away: a bare string is
     * rejected with "only one emotion intensity level per emotion type is
     * allowed", which is a check that only makes sense over a list. One entry,
     * because the console offers one choice.
     *
     * Only sent when explicitly chosen - see the note on CARTESIA_EMOTIONS.
     */
    ...(overrides.emotion
      ? { experimentalControls: { emotion: [overrides.emotion] } }
      : {}),
  };
}

/**
 * Read back the editable settings from a voice object as Vapi currently holds
 * it, so the console shows what the live agent is really doing rather than what
 * the pipeline once decided.
 */
export function readVoiceSettings(voice: Record<string, any> | null | undefined) {
  if (!voice) return null;
  const provider = String(voice.provider ?? "");
  const gc = voice.generationConfig ?? {};
  return {
    provider,
    voiceId: voice.voiceId ?? null,
    model: voice.model ?? null,
    language: voice.language ?? null,
    speed: provider === "cartesia" ? (gc.speed ?? null) : (voice.speed ?? null),
    volume: gc.volume ?? null,
    accentLocalization: gc.experimental?.accentLocalization ?? null,
    // Comes back as the array it was sent as; the console shows one.
    emotion:
      (Array.isArray(voice.experimentalControls?.emotion)
        ? voice.experimentalControls.emotion[0]
        : voice.experimentalControls?.emotion) ?? null,
  };
}
