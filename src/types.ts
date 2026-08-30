import { z } from "zod";

/* ------------------------------------------------------------------ *
 * TRANSCRIPT  (output of Phase 2, input to Phase 3)
 * PRD 3.2 - the transcript must distinguish agent from customer.
 * ------------------------------------------------------------------ */

export const TranscriptTurnSchema = z.object({
  speaker: z.enum(["agent", "customer"]),
  text: z.string(),
  start: z.number().optional(), // seconds; useful for manual correction
  end: z.number().optional(),
});

/**
 * Objective timing measurements taken from the audio (see
 * transcription/prosody.ts). Optional so that hand-written or hand-corrected
 * transcripts remain valid.
 */
export const ProsodySchema = z.object({
  words_per_minute: z.number(),
  speaking_seconds: z.number(),
  talk_ratio: z.number(),
  mean_intra_turn_pause: z.number(),
  long_pauses_per_100_words: z.number(),
  mean_response_latency: z.number(),
  mean_turn_duration: z.number(),
  segments: z.array(z.object({ start: z.number(), end: z.number() })),
});

export const TranscriptSchema = z.object({
  source: z.string(), // URL or filename - reproducibility, PRD 3.1
  notes: z.string().optional(),
  turns: z.array(TranscriptTurnSchema),
  /** Measured separately for each role; agent is the one we build a voice from. */
  prosody: z
    .object({ agent: ProsodySchema, customer: ProsodySchema })
    .optional(),
  /**
   * What the detection layer decided this recording is. Optional so that
   * transcripts produced before this layer existed still validate.
   */
  language: z.lazy(() => AudioLanguageProfileSchema).optional(),
  /** Which engine produced the words, for the write-up and for debugging. */
  transcribed_by: z.string().optional(),
});

export type TranscriptTurn = z.infer<typeof TranscriptTurnSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;

/* ------------------------------------------------------------------ *
 * AGENT SPEC  (output of Phase 3, input to Phase 4)
 * PRD 3.3 / 3.4 - behaviour, not a call summary.
 * Enums where possible so two specs are COMPARABLE, not just readable.
 * ------------------------------------------------------------------ */

const Level = z.enum(["low", "medium", "high"]);

export const AgentSpecSchema = z.object({
  // --- identity (PRD 3.3, bullet 1) ---
  role: z.string(),
  objective: z.string(),
  company_context: z.string(),
  product_context: z.string(),
  target_customer: z.string(),

  // --- tone (PRD 3.3, bullet 2) ---
  tone: z.object({
    style: z.enum([
      "friendly",
      "direct",
      "consultative",
      "persuasive",
      "neutral",
      "aggressive",
    ]),
    formality: Level,
    energy: Level,
    warmth: Level,
  }),

  // --- speaking style (PRD 3.3, bullet 3) ---
  speaking_style: z.object({
    response_length: z.enum(["very_short", "short", "medium", "long"]),
    avg_words_per_turn: z.number(),
    one_question_at_a_time: z.boolean(),
    question_style: z.string(),
    acknowledgements: z.array(z.string()), // "got it", "makes sense"
    filler_words: z.array(z.string()), // "um", "you know"
    vocabulary_complexity: z.enum(["simple", "moderate", "technical"]),
    uses_customer_name: z.boolean(),
  }),

  // --- conversation strategy (PRD 3.3, bullet 4) ---
  conversation_flow: z.object({
    opening: z.string(),
    discovery: z.string(),
    qualification: z.string(),
    pitch: z.string(),
    closing: z.string(),
    call_to_action: z.string(),
  }),

  objection_handling: z.object({
    style: z.string(), // "acknowledge then respond"
    aggressiveness: Level,
    persistence: Level,
    observed_objections: z.array(
      z.object({ objection: z.string(), response_pattern: z.string() })
    ),
  }),

  // --- behavioural rules (PRD 3.3, bullet 5) ---
  behavioural_rules: z.object({
    interruptibility: z.enum(["yields_easily", "balanced", "talks_over"]),
    patience: Level,
    transition_style: z.string(),
    hard_rules: z.array(z.string()), // becomes literal prompt rules in Phase 4
  }),

  // --- honesty about the method (PRD 5, "Limitations") ---
  evidence: z.object({
    signature_phrases: z.array(z.string()), // verbatim quotes from the agent
    directly_observed: z.array(z.string()),
    inferred: z.array(z.string()),
    confidence: Level,
  }),
});

export type AgentSpec = z.infer<typeof AgentSpecSchema>;

/* ------------------------------------------------------------------ *
 * VOICE PROFILE  (optional audio-derived layer)
 *
 * PRD 5 lists intonation, pitch and emphasis as limitations of a
 * transcript-only pipeline, and offers as an optional experiment the
 * comparison of transcript-only extraction against audio + transcript.
 * This schema is that experiment: it is produced by listening to the
 * agent's audio, and it is kept SEPARATE from AgentSpec so the two can be
 * generated and evaluated independently.
 * ------------------------------------------------------------------ */

export const VoiceProfileSchema = z.object({
  perceived_gender: z.enum(["male", "female", "ambiguous"]),
  /** Human-readable, e.g. "British English, southern, mildly estuary". */
  accent: z.string(),
  /** Constrained tag used to pick a TTS voice; free text cannot be mapped. */
  accent_code: z.enum([
    "en-US",
    "en-GB",
    "en-IN",
    "en-AU",
    "en-IE",
    "en-CA",
    "en-ZA",
    "other",
  ]),
  pitch: z.enum(["low", "medium", "high"]),
  timbre: z.string(),
  perceived_pace: z.enum(["slow", "moderate", "fast"]),
  pause_style: z.string(),
  emotional_register: z.string(),
  /** Delivery habits a TTS engine can plausibly approximate. */
  delivery_notes: z.array(z.string()),
  /** Things audible in the audio that the transcript alone could not reveal. */
  audio_only_observations: z.array(z.string()),
  confidence: z.enum(["low", "medium", "high"]),
});

export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

/**
 * What actually gets written to agent-spec.json: the text-derived spec plus,
 * when the audio pass has been run, the voice profile. AgentSpecSchema itself
 * stays untouched so the strict JSON schema we send the LLM never carries an
 * optional field (providers require every property to be required).
 */
export const StoredAgentSpecSchema = AgentSpecSchema.extend({
  voice_profile: VoiceProfileSchema.optional(),
});

export type StoredAgentSpec = z.infer<typeof StoredAgentSpecSchema>;

/* ------------------------------------------------------------------ *
 * AUDIO LANGUAGE PROFILE  (output of the detection layer, Phase 1.5)
 *
 * Produced before transcription and consumed three times afterwards: it
 * picks the offline STT, the live agent's realtime STT, and the TTS
 * voice. Stored with the transcript so a bad routing decision is visible
 * in an artifact rather than buried in a log line.
 * ------------------------------------------------------------------ */

export const LanguageSignalSchema = z.object({
  /** Which detector spoke: sarvam-lid, deepgram-lid, text-signals, llm-audio. */
  source: z.string(),
  language: z.string().nullable(),
  confidence: z.number(),
  detail: z.string(),
  /** Only the multimodal probe can judge accent rather than words. */
  indianSpeaker: z.boolean().optional(),
  codeMixed: z.boolean().optional(),
});

export const AudioLanguageProfileSchema = z.object({
  /** Our canonical key, e.g. "hi", "hi-Latn", "en-IN". */
  language: z.string(),
  label: z.string(),
  is_indian: z.boolean(),
  /** True for Hinglish and its regional equivalents. */
  code_mixed: z.boolean(),
  script: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  /** Which signal actually decided it, in plain words. */
  detected_by: z.string(),
  /**
   * Deepgram's own confidence in the words it returned from the probe, 0-1.
   * The transcription stage uses it to decide whether Deepgram can be trusted
   * with this recording once it is pointed at the right language.
   */
  deepgram_word_confidence: z.number().nullable().optional(),
  /** Every detector's verdict, kept so a wrong call can be audited. */
  signals: z.array(LanguageSignalSchema),
  notes: z.array(z.string()),
});

export type LanguageSignal = z.infer<typeof LanguageSignalSchema>;
export type AudioLanguageProfile = z.infer<typeof AudioLanguageProfileSchema>;
