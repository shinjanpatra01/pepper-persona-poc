import type { ProsodyFeatures } from "../transcription/prosody.js";
import type { VoiceProfile } from "../types.js";

/**
 * Map an observed voice profile onto a voice Vapi can actually speak with.
 *
 * Scope note: PRD 7 rules out voice cloning and custom TTS. So this does not
 * reproduce the source speaker's voice - it SELECTS the closest available
 * stock voice and sets a speaking rate measured from the recording. That is
 * the honest ceiling for this POC, and the gap between "same accent and pace"
 * and "same voice" belongs in the limitations section.
 *
 * Azure is the mapping target because its catalogue covers accent and gender
 * combinations with stable, predictable identifiers, which a lookup table can
 * rely on. Vapi's own built-in voice set is far smaller and US-centric.
 */

type Gender = VoiceProfile["perceived_gender"];
type AccentCode = VoiceProfile["accent_code"];

const AZURE_VOICES: Record<AccentCode, Record<"male" | "female", string>> = {
  "en-US": { male: "en-US-AndrewNeural", female: "en-US-AriaNeural" },
  "en-GB": { male: "en-GB-RyanNeural", female: "en-GB-SoniaNeural" },
  "en-IN": { male: "en-IN-PrabhatNeural", female: "en-IN-NeerjaNeural" },
  "en-AU": { male: "en-AU-WilliamNeural", female: "en-AU-NatashaNeural" },
  "en-IE": { male: "en-IE-ConnorNeural", female: "en-IE-EmilyNeural" },
  "en-CA": { male: "en-CA-LiamNeural", female: "en-CA-ClaraNeural" },
  "en-ZA": { male: "en-ZA-LukeNeural", female: "en-ZA-LeahNeural" },
  other: { male: "en-US-AndrewNeural", female: "en-US-AriaNeural" },
};

/** Conversational English sits around here; used as the 1.0x reference point. */
const BASELINE_WPM = 150;

export interface VoiceSelection {
  provider: "azure";
  voiceId: string;
  speed: number;
  /** Why this voice was chosen, for the evaluation write-up. */
  rationale: string[];
}

export function selectVoice(
  profile: VoiceProfile,
  prosody: ProsodyFeatures
): VoiceSelection {
  const rationale: string[] = [];

  // Gender: "ambiguous" has to resolve to something, since every TTS voice is
  // gendered. We fall back to male and say so rather than deciding silently.
  const gender: "male" | "female" =
    profile.perceived_gender === "female" ? "female" : "male";
  if (profile.perceived_gender === "ambiguous") {
    rationale.push(
      "Perceived gender was ambiguous; defaulted to a male voice. Override if wrong."
    );
  }

  const voiceId = AZURE_VOICES[profile.accent_code][gender];
  rationale.push(
    `Accent heard as "${profile.accent}" -> ${profile.accent_code}, ` +
      `${gender} -> ${voiceId}.`
  );
  if (profile.accent_code === "other") {
    rationale.push(
      "No stock voice matches this accent; fell back to US English. This is a " +
        "known fidelity gap for this recording."
    );
  }

  // Speed comes from the measurement, not from the model's impression of pace.
  // Clamped because Azure degrades audibly outside this range.
  let speed = 1;
  if (prosody.words_per_minute > 0) {
    speed = Math.round((prosody.words_per_minute / BASELINE_WPM) * 100) / 100;
    speed = Math.min(1.3, Math.max(0.75, speed));
    rationale.push(
      `Measured ${prosody.words_per_minute} words/min against a ${BASELINE_WPM} ` +
        `baseline -> speed ${speed}x.`
    );
  } else {
    rationale.push("No word timings available; left speed at 1.0x.");
  }

  return { provider: "azure", voiceId, speed, rationale };
}

/**
 * Turn the parts of the voice profile that TTS cannot control into prose for
 * the system prompt.
 *
 * A stock voice fixes accent, gender and rate, but not phrasing. Pause habits
 * and emotional register can still be nudged by instructing the language model
 * on how to write its replies - short sentences produce clipped delivery,
 * commas produce breath. So the profile influences the agent twice: once
 * through voice selection, once through the prompt.
 */
export function voiceDeliveryInstructions(
  profile: VoiceProfile,
  prosody: ProsodyFeatures
): string {
  const lines = [
    `Register: ${profile.emotional_register}`,
    `Your delivery is ${profile.perceived_pace}` +
      (prosody.words_per_minute > 0
        ? ` - the person you are modelled on spoke at about ${Math.round(
            prosody.words_per_minute
          )} words per minute.`
        : "."),
    `Pausing: ${profile.pause_style}`,
  ];

  for (const note of profile.delivery_notes) lines.push(note);

  lines.push(
    "Shape sentences for speech: short sentences read as clipped and decisive, " +
      "longer clauses separated by commas read as relaxed. Use that to control " +
      "your own rhythm."
  );

  return lines.join("\n");
}
