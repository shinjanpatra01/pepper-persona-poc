import { lookupLanguage } from "../audio/languages.js";
import { optionalEnv } from "../lib/env.js";
import type { ProsodyFeatures } from "../transcription/prosody.js";
import type { AudioLanguageProfile, VoiceProfile } from "../types.js";

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

/**
 * Words per minute each voice already delivers at 1.0x - the reference the
 * measured rate is divided by.
 *
 * This is per gender because Azure's male neural voices read noticeably
 * faster and more densely than the female ones at the same nominal speed.
 * Using one "conversational English" figure for both made male voices
 * overshoot: the Irish sales persona measured 226 wpm, mapped to 1.5x, and
 * clamped to 1.3x, which sounds rushed rather than brisk. Dividing by a
 * higher male baseline yields a lower multiplier for the same source speaker.
 *
 * Tunable without a code change, since the right value is a listening
 * judgement rather than something we can derive.
 */
const BASELINE_WPM = {
  male: Number(optionalEnv("VOICE_BASELINE_WPM_MALE", "200")),
  female: Number(optionalEnv("VOICE_BASELINE_WPM_FEMALE", "155")),
};

/**
 * Upper bound on the multiplier, also per gender. Male voices degrade audibly
 * sooner - consonants start clipping - so they are held to a tighter ceiling.
 */
const MAX_SPEED = {
  male: Number(optionalEnv("VOICE_MAX_SPEED_MALE", "1.15")),
  female: Number(optionalEnv("VOICE_MAX_SPEED_FEMALE", "1.3")),
};

/*
 * Floor on the multiplier, raised from 0.75 after listening to a real agent.
 *
 * A TTS speed slider does not make a voice speak slowly - it stretches the
 * rendered audio. Vowels drag, consonants smear, and the sentence melody flattens
 * out. Below about 0.9x that is audible as "robot", and it swamped whatever
 * fidelity the measured pace was buying: a 154 wpm speaker mapped to 0.77x and
 * the result sounded synthetic in a way the source recording never did.
 *
 * A slow speaker is now expressed by choosing a slower-sounding voice and by
 * the pacing instructions in the prompt, not by degrading the audio.
 */
const MIN_SPEED = Number(optionalEnv("VOICE_MIN_SPEED", "0.9"));

export type TtsProvider = "azure" | "cartesia";

/**
 * Which TTS renders the persona.
 *
 * Azure is the default because its catalogue is exhaustive and its identifiers
 * are stable strings a lookup table can hardcode. It is also the most robotic
 * of the options: flat prosody, the same falling contour on every sentence, no
 * breath. Cartesia Sonic sounds markedly more human and is much faster to first
 * audio, which matters as much as timbre on a live call - but its voices are
 * account-scoped UUIDs, so they have to be configured rather than looked up.
 */
export function ttsProvider(): TtsProvider {
  return optionalEnv("VAPI_TTS_PROVIDER", "azure") === "cartesia"
    ? "cartesia"
    : "azure";
}

export interface VoiceSelection {
  provider: TtsProvider;
  voiceId: string;
  /** Cartesia needs the language spelled out; Azure carries it in the voice id. */
  language?: string;
  /** Cartesia model, e.g. sonic-2. Unused by Azure. */
  model?: string;
  speed: number;
  /** Why this voice was chosen, for the evaluation write-up. */
  rationale: string[];
}

export function selectVoice(
  profile: VoiceProfile,
  prosody: ProsodyFeatures,
  /**
   * The detected language of the source recording. When present it OVERRIDES
   * the accent heard by the voice analyser, because the two answer different
   * questions and only one of them is decisive: a Hindi call needs a Hindi
   * voice even if the analyser described the accent as "Indian English", and an
   * en-US voice reading Hindi text does not produce accented Hindi - it
   * produces an English speaker mangling Hindi phonemes.
   */
  language?: AudioLanguageProfile
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

  const languageRow = language ? lookupLanguage(language.language) : undefined;

  let voiceId: string;
  if (languageRow && languageRow.indian) {
    voiceId = languageRow.azureVoices[gender];
    rationale.push(
      `Recording detected as ${languageRow.label} (${language!.detected_by}), ` +
        `so the voice is locked to ${languageRow.azureLocale}: ${voiceId}.`
    );
    if (profile.accent_code !== "en-IN" && profile.accent_code !== "other") {
      // Worth saying out loud: the two signals disagreed and we picked one.
      rationale.push(
        `The voice analyser heard "${profile.accent}" (${profile.accent_code}), ` +
          "which disagrees with the detected language. The detected language " +
          "wins, because a voice in the wrong language cannot pronounce the " +
          "words at all, whereas a voice in the wrong accent merely sounds off."
      );
    }
    if (language!.code_mixed) {
      rationale.push(
        `${languageRow.azureLocale} voices read embedded English words natively, ` +
          "which is what makes them the right choice for code-mixed speech."
      );
    }
  } else {
    voiceId = AZURE_VOICES[profile.accent_code][gender];
    rationale.push(
      `Accent heard as "${profile.accent}" -> ${profile.accent_code}, ` +
        `${gender} -> ${voiceId}.`
    );
  }

  if (!languageRow?.indian && profile.accent_code === "other") {
    rationale.push(
      "No stock voice matches this accent; fell back to US English. This is a " +
        "known fidelity gap for this recording."
    );
  }

  /*
   * Speed comes from the measurement, not from the model's impression of pace -
   * but the measurement and the baseline have to be in the same units.
   *
   * The measured number is a word COUNT per minute, and languages differ in how
   * many words a minute of speech contains. Dividing a Hindi count by an
   * English baseline understated every Indian-language speaker: one real call
   * measured 184 wpm of Hindi, was divided by the 200 wpm English male
   * baseline, and produced 0.92x - slower than the Azure default - for a
   * speaker the voice analyser had independently described as "fast".
   *
   * So the baseline is per locale, with the English figures kept as the
   * fallback for anything not in the table.
   */
  const baseline =
    (languageRow &&
      Number(
        optionalEnv(
          `VOICE_BASELINE_WPM_${languageRow.azureLocale.toUpperCase().replace("-", "_")}_${gender.toUpperCase()}`,
          String(languageRow.baselineWpm[gender])
        )
      )) ||
    BASELINE_WPM[gender];
  const ceiling = MAX_SPEED[gender];

  let speed = 1;
  if (prosody.words_per_minute > 0) {
    const raw = prosody.words_per_minute / baseline;
    speed = Math.round(Math.min(ceiling, Math.max(MIN_SPEED, raw)) * 100) / 100;
    rationale.push(
      `Measured ${prosody.words_per_minute} words/min against a ${baseline} ` +
        `${gender} baseline -> ${raw.toFixed(2)}x` +
        (raw > ceiling
          ? `, capped at ${ceiling}x.`
          : raw < MIN_SPEED
            ? `, raised to ${MIN_SPEED}x.`
            : ".")
    );
  } else {
    rationale.push("No word timings available; left speed at 1.0x.");
  }

  // A disagreement worth printing rather than silently resolving. The analyser
  // heard the speaker; the arithmetic counted their words. When they point in
  // opposite directions the baseline for this locale is probably mis-tuned, and
  // that is a listening judgement rather than something we can derive here.
  if (profile.perceived_pace === "fast" && speed < 1) {
    rationale.push(
      `The voice analyser heard this speaker as fast, but the measured count ` +
        `came out below the ${baseline} wpm baseline for ${
          languageRow?.azureLocale ?? "this locale"
        }. If the agent sounds sluggish, lower that baseline.`
    );
  }
  if (profile.perceived_pace === "slow" && speed > 1.05) {
    rationale.push(
      "The voice analyser heard this speaker as slow but the measured count " +
        "came out above the baseline. Raise the baseline if the agent rushes."
    );
  }

  if (ttsProvider() === "cartesia") {
    /*
     * Cartesia voices are UUIDs owned by your Cartesia account, so unlike the
     * Azure table they cannot be shipped in the source. They are read per
     * language and gender from the environment, and a missing one is an error
     * rather than a silent fall back to Azure: falling back would mean the
     * operator asks for the good TTS, gets the robotic one, and never finds out.
     */
    const localeKey = (languageRow?.azureLocale ?? "en-US")
      .toUpperCase()
      .replace("-", "_");
    const envKey = `CARTESIA_VOICE_${localeKey}_${gender.toUpperCase()}`;
    const cartesiaVoice = optionalEnv(envKey, "");
    if (!cartesiaVoice) {
      throw new Error(
        `VAPI_TTS_PROVIDER=cartesia but ${envKey} is not set. Cartesia voice ` +
          "ids are account-scoped UUIDs; list yours at " +
          "https://api.cartesia.ai/voices and put the one you want in .env."
      );
    }
    rationale.push(
      `Cartesia Sonic instead of Azure: ${envKey}=${cartesiaVoice}. Azure's ` +
        "neural voices are the most robotic of the options at this price."
    );
    return {
      provider: "cartesia",
      voiceId: cartesiaVoice,
      /*
       * Cartesia takes a bare ISO language, not a locale: "hi", never "hi-IN"
       * or "en-IN". Our own codes carry a region or a script ("hi-Latn" for
       * Hinglish), so the leading subtag is the whole answer - and it is the
       * right one for Hinglish too, which Cartesia renders as Hindi with the
       * English words read natively.
       */
      language: (languageRow?.code ?? "en").split("-")[0],
      model: optionalEnv("CARTESIA_MODEL", "sonic-2"),
      speed,
      rationale,
    };
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
