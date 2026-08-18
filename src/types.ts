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

export const TranscriptSchema = z.object({
  source: z.string(), // URL or filename - reproducibility, PRD 3.1
  notes: z.string().optional(),
  turns: z.array(TranscriptTurnSchema),
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
