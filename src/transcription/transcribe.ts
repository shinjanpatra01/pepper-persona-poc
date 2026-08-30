import {
  DEEPGRAM_CONFIDENCE_FLOOR,
  detectAudioLanguage,
  reviewCodeMixing,
} from "../audio/detectLanguage.js";
import { lookupLanguage } from "../audio/languages.js";
import { hasSarvam } from "./sarvam.js";
import type { AudioLanguageProfile, Transcript, TranscriptTurn } from "../types.js";
import { transcribeWithDeepgram, type DeepgramUtterance } from "./deepgram.js";
import { transcribeIndianAudio } from "./indianTranscribe.js";
import { measureProsody } from "./prosody.js";
import { decideAgentSpeaker, type SpeakerDecision } from "./speakers.js";

export interface TranscribeOptions {
  /** Local audio file path, or a direct https URL to a media file. */
  source: string;
  /** Free-text note about where the recording came from (PRD 3.1). */
  notes?: string;
  /** Force which Deepgram speaker number is the agent, skipping the heuristic. */
  agentSpeaker?: number;
  /** Skip language detection and transcribe as this language. */
  forceLanguage?: string;
  /** Detect the language but transcribe with Deepgram regardless. */
  skipIndianPath?: boolean;
  onProgress?: (message: string) => void;
}

export interface TranscribeResult {
  transcript: Transcript;
  decision: SpeakerDecision;
  /** True when the caller overrode the heuristic. */
  overridden: boolean;
  language: AudioLanguageProfile;
  transcribedBy: string;
  warnings: string[];
}

/**
 * Consecutive utterances from the same speaker are merged into a single turn.
 *
 * Deepgram splits on pauses, so one spoken sentence often arrives as three
 * utterances. Merging gives the Phase 3 analyser real conversational turns,
 * which matters because we ask it to judge response LENGTH - unmerged
 * fragments would make every agent look terse.
 */
function toTurns(
  utterances: DeepgramUtterance[],
  agentSpeaker: number
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];

  for (const u of utterances) {
    if (!u.transcript) continue;
    const speaker = u.speaker === agentSpeaker ? "agent" : "customer";
    const previous = turns[turns.length - 1];

    if (previous && previous.speaker === speaker) {
      previous.text = `${previous.text} ${u.transcript}`.trim();
      previous.end = u.end;
    } else {
      turns.push({
        speaker,
        text: u.transcript,
        start: u.start,
        end: u.end,
      });
    }
  }

  return turns;
}

export async function buildTranscript(
  options: TranscribeOptions
): Promise<TranscribeResult> {
  const log = options.onProgress ?? (() => {});
  const warnings: string[] = [];
  const isUrl = /^https?:\/\//i.test(options.source);

  // Detection needs the bytes on disk - it cuts a probe sample with ffmpeg -
  // so a URL source skips straight to the Deepgram path unless the operator
  // named the language explicitly.
  let language: AudioLanguageProfile;
  if (isUrl && !options.forceLanguage) {
    warnings.push(
      "Source is a URL, so the audio could not be sampled for language " +
        "detection. Download it locally, or pass --language=<code>, to use the " +
        "Indian-language path."
    );
    language = {
      language: "en",
      label: "English",
      is_indian: false,
      code_mixed: false,
      script: "latin",
      confidence: "low",
      detected_by: "not run (remote source)",
      deepgram_word_confidence: null,
      signals: [],
      notes: [warnings[warnings.length - 1]!],
    };
  } else {
    log("Detecting the language and accent of the recording...");
    language = await detectAudioLanguage({
      audioPath: options.source,
      forceLanguage: options.forceLanguage,
    });
    log(
      `  -> ${language.label} (${language.language})` +
        `${language.code_mixed ? ", code-mixed with English" : ""}` +
        `, ${language.confidence} confidence, via ${language.detected_by}.`
    );
    for (const note of language.notes) log(`  ! ${note}`);
  }

  const row = lookupLanguage(language.language) ?? lookupLanguage("en")!;

  // Deepgram always runs. For an Indian language it is not producing the words
  // we keep - it is producing the speaker timeline, which is the one thing it
  // does just as well in Hindi as in English. Asking it for the right language
  // when it has one costs nothing and makes the fallback path usable on its own.
  log("Transcribing with Deepgram (diarisation on)...");
  let utterances = await transcribeWithDeepgram(options.source, {
    language: row.deepgram ?? undefined,
  });

  const decision = decideAgentSpeaker(utterances);
  let transcribedBy = `deepgram (${row.deepgram ?? "en"})`;

  /*
   * When to use Sarvam.
   *
   * Default: always, for any detected Indian language other than Indian
   * English. An earlier version gated this on Deepgram's own word confidence,
   * on the theory that a confident Deepgram could be trusted. That theory was
   * wrong. Confidence collapses when an ENGLISH model meets Hindi audio, but
   * once detection points Deepgram at language=hi it becomes confident and
   * merely mediocre - a real property call scored 0.975 while rendering the
   * project name "Gaur Alaris" five different ways. A gate that can never fire
   * is not a gate, so the escalation is now the default and the confidence
   * number is reported rather than acted on.
   *
   * --deepgram opts out, which is how you compare the two engines.
   */
  const confidence = language.deepgram_word_confidence ?? null;
  const indianLanguage = row.indian && row.code !== "en-IN";
  const needsSarvam = indianLanguage && !options.skipIndianPath;

  if (indianLanguage && options.skipIndianPath) {
    log(
      `  --deepgram given, so ${row.label} stays with Deepgram` +
        (confidence !== null ? ` (word confidence ${confidence.toFixed(2)})` : "") +
        "."
    );
  }

  if (needsSarvam && !hasSarvam()) {
    warnings.push(
      `Detected ${row.label}, but no SARVAM_API_KEY is set. Falling back to ` +
        `Deepgram${row.deepgram ? "" : ", which has no model for this language"}. ` +
        "The transcript is likely to be wrong."
    );
  } else if (needsSarvam) {
    log(`Re-transcribing ${row.label} turn by turn with Sarvam...`);
    const sarvam = await transcribeIndianAudio({
      audioPath: options.source,
      utterances,
      language: row,
      onProgress: (done, total) => {
        if (done === total || done % 10 === 0) log(`  ${done}/${total} turns`);
      },
    });
    utterances = sarvam.utterances;
    warnings.push(...sarvam.warnings);
    transcribedBy = `sarvam saaras (${row.sarvam}) over deepgram diarisation`;
    log(`  -> ${utterances.length} turns transcribed by Sarvam.`);
  }

  const overridden = options.agentSpeaker !== undefined;
  const agentSpeaker = options.agentSpeaker ?? decision.agentSpeaker;

  // Prosody is measured here, against the raw utterances, because the optional
  // LLM repair pass later re-segments the text and drops timings. The numbers
  // therefore reflect the ACOUSTIC speaker assignment; if the repair pass swaps
  // a few boundaries the effect on aggregate rate and pause statistics is
  // negligible, but it is a real caveat worth documenting.
  const customerSpeakers = [
    ...new Set(utterances.map((u) => u.speaker)),
  ].filter((s) => s !== agentSpeaker);

  const turns = toTurns(utterances, agentSpeaker);

  // Now that the whole call has been transcribed, re-measure the one part of
  // the profile a short probe cannot judge: how much English is mixed in.
  const before = language.code_mixed;
  language = reviewCodeMixing(language, turns.map((t) => t.text).join(" "));
  if (language.code_mixed && !before) {
    log(
      "  Code-mixing found in the full transcript that the probe missed; the " +
        "agent will be told to mix English the way the source speaker did."
    );
  }

  return {
    transcript: {
      source: options.source,
      notes: options.notes,
      turns,
      prosody: {
        agent: measureProsody(utterances, agentSpeaker),
        customer: measureProsody(utterances, customerSpeakers[0] ?? -1),
      },
      language,
      transcribed_by: transcribedBy,
    },
    decision,
    overridden,
    language,
    transcribedBy,
    warnings,
  };
}
