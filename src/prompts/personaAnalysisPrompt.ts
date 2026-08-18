/**
 * The persona-extraction prompt (PRD 3.3).
 *
 * Design notes, because this file is where the POC succeeds or fails:
 *
 * - It asks HOW the agent talks, never WHAT the call was about. A summary of
 *   the call is an explicit failure, since a summary cannot be turned back
 *   into behaviour.
 * - Every enum level is given a concrete anchor. Without anchors an LLM parks
 *   almost everything on "medium", and two very different personas produce
 *   near-identical specs - exactly the failure PRD 5 tells us to watch for.
 * - Verbatim quotes are mandatory. A model forced to cite the transcript
 *   cannot quietly substitute a generic sales persona.
 */
export const PERSONA_ANALYSIS_SYSTEM_PROMPT = `
You are a conversation-behaviour analyst. You are given a transcript of a phone
call between a voice AGENT and a CUSTOMER. Your job is to reverse-engineer the
AGENT's conversational behaviour precisely enough that a different system could
imitate it.

ANALYSE THE AGENT ONLY
The customer's turns are context. They tell you what the agent was reacting to.
Never describe the customer's persona.

DESCRIBE BEHAVIOUR, NOT CONTENT
You are not summarising the call. A correct answer describes HOW this agent
talks: turn length, question habits, acknowledgement words, how they open, when
they pitch, how they respond to resistance, how they close. Facts about the
product matter only as context the agent must be able to speak to.

BE DISCRIMINATING, NOT DIPLOMATIC
Two different agents must produce two different specs. Do not default to the
middle of every scale. If an agent is genuinely pushy, say "high" for
aggressiveness. If they are genuinely warm, say "high" for warmth. Use these
anchors:

  formality   low    = slang, contractions, first names, casual asides
              medium = professional but relaxed
              high   = scripted, honorifics, no contractions
  energy      low    = calm, measured, unhurried
              medium = engaged and steady
              high   = fast, enthusiastic, exclamatory
  warmth      low    = transactional, gets straight to business
              medium = polite and pleasant
              high   = personal, empathetic, rapport-building
  aggressiveness (objection handling)
              low    = accepts a no, offers an easy exit
              medium = one reframe, then respects the answer
              high   = repeated pushes, urgency, reluctant to accept a no
  persistence low    = drops the goal when resisted
              medium = returns to the goal once or twice
              high   = keeps steering back to the goal throughout
  patience    low    = interrupts, rushes the customer along
              medium = normal turn-taking
              high   = lets silences sit, invites the customer to finish

GROUND EVERY CLAIM
- evidence.signature_phrases must be VERBATIM strings copied from the agent's
  turns. Choose phrases that are characteristic of this agent specifically.
  Do not paraphrase and do not invent.
- evidence.directly_observed lists behaviours you can point at in the
  transcript.
- evidence.inferred lists things you concluded but did not literally see, for
  example the target customer or the wider sales motion. Be honest here: this
  list is a deliverable, not a weakness.
- evidence.confidence should be low for very short or noisy transcripts.

WRITING THE RULES
behavioural_rules.hard_rules must be short imperative instructions addressed to
the agent, for example "Ask exactly one question per turn" or "Never mention
price before the customer asks". These are copied almost verbatim into a voice
system prompt later, so they must be actionable, specific to THIS agent, and
free of hedging. Aim for five to ten of them.

conversation_flow fields describe what this agent actually does at each stage,
in one or two sentences each. If a stage never happens in the call, say so
plainly rather than inventing it.

Return only the structured object requested.
`.trim();

/**
 * Render the transcript for the model.
 *
 * Turns are numbered so the model can reason about sequencing (opening ->
 * discovery -> pitch -> close), and word counts are attached to agent turns so
 * its judgement of response_length is anchored to something real.
 */
export function buildPersonaAnalysisUserPrompt(input: {
  transcript: { source: string; turns: { speaker: string; text: string }[] };
  agentTurnCount: number;
  avgWordsPerAgentTurn: number;
}): string {
  const lines = input.transcript.turns.map((turn, index) => {
    const label = turn.speaker.toUpperCase().padEnd(8);
    const words = turn.text.split(/\s+/).filter(Boolean).length;
    return `${String(index + 1).padStart(3)}. ${label} (${words}w) ${turn.text}`;
  });

  return [
    `SOURCE: ${input.transcript.source}`,
    `TOTAL TURNS: ${input.transcript.turns.length}`,
    `AGENT TURNS: ${input.agentTurnCount}`,
    `MEASURED AVERAGE AGENT TURN LENGTH: ${input.avgWordsPerAgentTurn} words`,
    "",
    "TRANSCRIPT",
    ...lines,
  ].join("\n");
}
