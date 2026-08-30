import { optionalEnv } from "../lib/env.js";
import type { AgentSpec } from "../types.js";
import { vapi, type VapiAssistant } from "./client.js";
import type { TranscriberSelection } from "./languageRouting.js";
import type { VoiceSelection } from "./voiceMapping.js";
import { buildVoicePayload, type VoiceOverrides } from "./voiceOverrides.js";

/**
 * Create or update the recreated agent in Vapi (PRD 4.2).
 *
 * PRD 4.2 says to use Vapi defaults wherever possible for model, STT, TTS and
 * turn handling. That is a real design choice, not laziness: the POC is testing
 * whether the extracted PERSONA transfers, so every knob we leave at default is
 * one fewer variable confounding that answer. The only things we set are the
 * ones that carry the persona - the system prompt and the opening line.
 */
export interface CreateAgentInput {
  spec: AgentSpec;
  systemPrompt: string;
  firstMessage: string;
  /**
   * Short lines spoken when the caller goes quiet, generated in the persona's
   * own voice. Omitted, Vapi says nothing into a silence at all - which reads
   * as the agent having hung up.
   */
  idleMessages?: string[];
  /** Recording folder name, used to make the assistant recognisable in the UI. */
  label: string;
  /** Update this assistant instead of creating a new one. */
  existingAssistantId?: string;
  /**
   * Chosen from the audio-derived voice profile, when the optional voice pass
   * has been run. Omitted, Vapi picks its own default voice - which keeps the
   * transcript-only path a clean control for the PRD 5 comparison.
   */
  voice?: VoiceSelection;
  /**
   * Voice settings changed from the console. Applied on top of the derived
   * voice, because someone who listened to a call knows more than the
   * arithmetic that produced the starting point.
   */
  voiceOverrides?: VoiceOverrides;
  /**
   * Chosen by the language detection layer. Omitted for plain English, where
   * Vapi's English default is already correct and leaving it alone preserves
   * the PRD 4.2 "defaults wherever possible" property.
   */
  transcriber?: TranscriberSelection;
}

export interface CreateAgentResult {
  assistant: VapiAssistant;
  created: boolean;
}

export async function createOrUpdateAgent(
  input: CreateAgentInput
): Promise<CreateAgentResult> {
  // Vapi caps assistant names at 40 characters.
  const name = `${input.label} - ${input.spec.role}`.slice(0, 40);

  const chatModel = optionalEnv("VAPI_MODEL", "gpt-5.6-luna");

  const payload: Record<string, unknown> = {
    name,
    firstMessage: input.firstMessage,
    /*
     * gpt-5.6-luna rather than gpt-4o-mini.
     *
     * The job on a live call is one short reply in the persona's own register,
     * and the earlier reasoning still holds: on voice, waiting is the loudest
     * tell that you are talking to software. Luna is chosen for the same reason
     * mini was - it answers fast - while following a long persona instruction
     * list far more tightly than mini did, which was mini's one real cost.
     *
     * VAPI_MODEL still overrides, so a persona can be put back on gpt-4o-mini
     * if the latency on a given account turns out worse.
     */
    model: {
      provider: "openai",
      model: chatModel,
      messages: [{ role: "system", content: input.systemPrompt }],
      /*
       * The gpt-5 family reasons before answering, and on a phone call that
       * thinking time is dead air. The persona is not a reasoning problem -
       * it is one short reply in a register the prompt already fixed - so the
       * effort buys nothing and costs the thing that matters most.
       *
       * Sent only for models that accept it: Vapi validates this per model,
       * so attaching it to gpt-4o-mini is a 400 rather than a no-op.
       */
      ...(chatModel.startsWith("gpt-5")
        ? { reasoningEffort: optionalEnv("VAPI_REASONING_EFFORT", "minimal") }
        : {}),
    },
    /*
     * Turn taking is the third deliberate exception to "use the defaults".
     *
     * Vapi's defaults are tuned for an assistant answering questions, and on a
     * real outbound call they produce the failure that makes a persona sound
     * synthetic: the caller pauses to think, the agent takes the pause as its
     * turn, and it keeps talking - re-explaining, stacking questions, pitching
     * into dead air. No amount of prompt writing fixes that, because by the
     * time the model is asked for a turn the decision to speak has been made.
     *
     * So the pauses a human leaves are configured here, and what to SAY in
     * them comes from the persona (idleMessages) rather than from Vapi's
     * English default.
     */
    startSpeakingPlan: {
      /*
       * Time added before EVERY reply, so it is bought at the cost of feeling
       * slow. 0.8s was too expensive: it bought a little interrupt safety and
       * made the whole agent laggy. 0.4 still covers the short breath people
       * take mid-sentence, which is the pause worth waiting through.
       */
      waitSeconds: Number(optionalEnv("VAPI_WAIT_SECONDS", "0.4")),
      // LiveKit's endpointing model is English-only, so it is switched on only
      // for the English path; on a Hindi call it would mis-detect turn ends and
      // make the interrupting worse than the plain timeout it replaces.
      ...(input.transcriber
        ? {}
        : { smartEndpointingPlan: { provider: "livekit" as const } }),
      /*
       * How long Vapi waits, after the transcriber stops producing words,
       * before deciding the caller is done and calling the model.
       *
       * The default for an unpunctuated ending is 1.5 seconds, and on a Hindi
       * call almost every ending is unpunctuated: Deepgram's Hindi models
       * punctuate rarely, so the confident-and-fast path is nearly never
       * taken and the agent pays the full slow-path wait on essentially every
       * turn. That is the single largest source of "it reacts late", and it
       * is invisible in the prompt and in the model choice, which is why it
       * survived so long.
       *
       * 0.6 is short enough to feel like a reply and long enough to sit
       * through the pause in the middle of a sentence. It trades an
       * occasional early interruption for a response time that reads human -
       * the right trade, because being cut off is a thing people do and
       * waiting two seconds is not.
       */
      transcriptionEndpointingPlan: {
        onPunctuationSeconds: Number(optionalEnv("VAPI_ENDPOINT_PUNCTUATION", "0.1")),
        onNoPunctuationSeconds: Number(
          optionalEnv("VAPI_ENDPOINT_NO_PUNCTUATION", "0.6")
        ),
        onNumberSeconds: Number(optionalEnv("VAPI_ENDPOINT_NUMBER", "0.4")),
      },
    },
    stopSpeakingPlan: {
      // Yield the floor the moment the caller starts talking over the agent.
      numWords: 0,
      voiceSeconds: 0.2,
      // How long the agent stays quiet after being cut off. Kept short so the
      // recovery does not read as a stall.
      backoffSeconds: 0.6,
    },
    // Hang up only after a genuinely dead line. Someone who has gone quiet is
    // still on the call, and the idle messages below are what handles them.
    silenceTimeoutSeconds: Number(optionalEnv("VAPI_SILENCE_TIMEOUT", "60")),
  };

  /*
   * Idle messages are the answer to "the caller said nothing". Vapi speaks one
   * after idleTimeoutSeconds of silence, in order, and stops after the count
   * below - so the generated lines escalate from a check-in to a polite exit
   * and then the call ends, instead of the agent talking on forever.
   */
  if (input.idleMessages && input.idleMessages.length > 0) {
    payload.messagePlan = {
      idleMessages: input.idleMessages,
      idleMessageMaxSpokenCount: input.idleMessages.length,
      /*
       * 8s was measured as too eager. A person thinking about a budget or a
       * site visit is silent for longer than that, and being prodded every
       * eight seconds - then told "I will call back later" after four prods -
       * is its own kind of not-listening. 15s is a long pause by the standards
       * of a phone call, which is the point: the nudge should arrive after the
       * silence has become awkward, not while the person is still thinking.
       */
      idleTimeoutSeconds: Number(optionalEnv("VAPI_IDLE_TIMEOUT", "15")),
    };
  }

  // The transcriber is the second deliberate exception to "use the defaults".
  // Vapi's default listens in English; for a Hindi or Tamil persona that is not
  // a tuning choice we are declining to make, it is a broken agent.
  if (input.transcriber) {
    payload.transcriber = input.transcriber.config;
  }

  // Voice is the one default we override, and only when we have measured
  // evidence for it. Accent, gender and rate are the parts of a persona a
  // stock TTS voice can actually carry.
  //
  // The payload is assembled in voiceOverrides so that the console and this
  // CLI cannot produce different voice objects for the same settings.
  if (input.voice) {
    payload.voice = buildVoicePayload(input.voice, input.voiceOverrides);
  }

  if (input.existingAssistantId) {
    const assistant = await vapi.patch<VapiAssistant>(
      `/assistant/${input.existingAssistantId}`,
      payload
    );
    return { assistant, created: false };
  }

  const assistant = await vapi.post<VapiAssistant>("/assistant", payload);
  return { assistant, created: true };
}
