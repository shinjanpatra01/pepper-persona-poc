import type { AgentSpec } from "../types.js";

/**
 * The Agent Spec -> system prompt step (PRD 4.1).
 *
 * The hard constraint from the PRD is that this generator must not encode a
 * persona of its own. It knows the SHAPE of a good voice system prompt - the
 * eight sections below - and nothing about sales or support. Every trait, rule
 * and phrase must come from the spec it is handed, so that two different specs
 * necessarily produce two different prompts.
 */
export const AGENT_GENERATION_SYSTEM_PROMPT = `
You write system prompts for real-time voice agents.

You will be given a structured Agent Spec that was reverse-engineered from a
recording of a human or AI agent on a phone call. Turn it into a system prompt
that makes a voice model behave like that specific agent.

OUTPUT STRUCTURE
Use exactly these sections, as markdown headings, in this order:

  # Identity
  # Objective
  # Voice and Tone
  # Response Rules
  # Conversation Flow
  # Objection Handling
  # Closing
  # Guardrails

WRITE FOR SPEECH, NOT FOR READING
This prompt drives a voice conversation. Therefore:
  - Give concrete, checkable instructions ("keep replies under 25 words"),
    never vague ones ("be concise").
  - Turn every tone attribute into observable behaviour. "warmth: high" becomes
    an instruction to acknowledge feelings before moving on, not the word
    "warm" dropped into a sentence.
  - Forbid anything that only works in text: lists, bullet points, headings,
    emoji, URLs, markdown, spelled-out punctuation.
  - Instruct the agent to speak numbers, dates and prices the way a person
    would say them out loud.

FIDELITY TO THE SPEC
  - The Response Rules section must contain every hard rule from the spec,
    reworded as a direct instruction to the agent but not softened or dropped.
  - Reuse the spec's signature phrases and acknowledgement words as examples of
    how this agent talks. Present them as characteristic phrasing to draw on,
    not as a script to recite verbatim every call.
  - Match the spec's aggressiveness and persistence honestly. If the source
    agent pushed back hard on a "no", the generated agent must too. Do not
    sand down an assertive persona into a polite one, and do not make a calm
    service persona pushy.
  - Reflect the measured response length. A short-response agent should be told
    to hold most turns to roughly the measured word count.

GUARDRAILS SECTION
Always include: never invent facts about the product, pricing or availability
that are not in this prompt; if asked something unknown, say so plainly and
offer a follow-up; end the call politely if the person asks to be left alone.
Add any further limits implied by the spec.

FIRST MESSAGE
Also produce the single line the agent speaks first, in this agent's voice and
style. It must sound like the source agent's opening, be one or two sentences,
and contain no stage directions.

Never mention the Agent Spec, the recording, or that you are imitating anyone.
The finished prompt must read as the agent's own instructions.
`.trim();

const bullets = (items: string[]) =>
  items.length > 0 ? items.map((i) => `  - ${i}`).join("\n") : "  - (none observed)";

/**
 * Render the spec as a readable brief rather than raw JSON.
 *
 * The model writes better prose from prose, and doing the formatting here means
 * any mistake in the output is a writing failure we can read and fix, not a
 * JSON-parsing accident hidden inside the model.
 */
export function buildAgentGenerationUserPrompt(spec: AgentSpec): string {
  return `
AGENT SPEC

Role: ${spec.role}
Objective: ${spec.objective}
Company context: ${spec.company_context}
Product context: ${spec.product_context}
Target customer: ${spec.target_customer}

TONE
  style: ${spec.tone.style}
  formality: ${spec.tone.formality}
  energy: ${spec.tone.energy}
  warmth: ${spec.tone.warmth}

SPEAKING STYLE
  response length: ${spec.speaking_style.response_length} (measured average ${spec.speaking_style.avg_words_per_turn} words per turn)
  one question at a time: ${spec.speaking_style.one_question_at_a_time}
  question style: ${spec.speaking_style.question_style}
  vocabulary: ${spec.speaking_style.vocabulary_complexity}
  uses the customer's name: ${spec.speaking_style.uses_customer_name}
  acknowledgements:
${bullets(spec.speaking_style.acknowledgements)}
  filler words:
${bullets(spec.speaking_style.filler_words)}

CONVERSATION FLOW
  opening: ${spec.conversation_flow.opening}
  discovery: ${spec.conversation_flow.discovery}
  qualification: ${spec.conversation_flow.qualification}
  pitch: ${spec.conversation_flow.pitch}
  closing: ${spec.conversation_flow.closing}
  call to action: ${spec.conversation_flow.call_to_action}

OBJECTION HANDLING
  style: ${spec.objection_handling.style}
  aggressiveness: ${spec.objection_handling.aggressiveness}
  persistence: ${spec.objection_handling.persistence}
  observed objections and how this agent answered them:
${bullets(
  spec.objection_handling.observed_objections.map(
    (o) => `"${o.objection}" -> ${o.response_pattern}`
  )
)}

BEHAVIOURAL RULES
  interruptibility: ${spec.behavioural_rules.interruptibility}
  patience: ${spec.behavioural_rules.patience}
  transition style: ${spec.behavioural_rules.transition_style}
  hard rules (all of these must survive into Response Rules):
${bullets(spec.behavioural_rules.hard_rules)}

CHARACTERISTIC PHRASING (verbatim from the source recording)
${bullets(spec.evidence.signature_phrases)}
`.trim();
}
