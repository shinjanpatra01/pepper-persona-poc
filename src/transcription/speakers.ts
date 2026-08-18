import type { DeepgramUtterance } from "./deepgram.js";

/**
 * Deepgram tells us there are two voices; it cannot tell us which one is the
 * sales/support agent. Everything downstream depends on getting this right -
 * if the labels are flipped we would extract the CUSTOMER's persona and the
 * result would still look plausible, which is the worst kind of bug.
 *
 * So we score each speaker on agent-likelihood using cues that genuinely
 * separate the two roles, then print the reasoning so a human can override.
 */

/** Phrases an agent says about themselves, and a customer essentially never does. */
const AGENT_SELF_INTRO = [
  "calling from",
  "my name is",
  "this is",
  "i'm with",
  "i am with",
  "on behalf of",
  "how can i help",
  "how may i help",
  "thank you for calling",
  "reaching out",
  "i wanted to",
  "do you have a quick",
  "is now a good time",
];

export interface SpeakerDecision {
  agentSpeaker: number;
  confidence: "low" | "medium" | "high";
  reasons: string[];
}

interface SpeakerStats {
  speaker: number;
  turns: number;
  words: number;
  questions: number;
  introHits: number;
  firstIndex: number;
}

function collectStats(utterances: DeepgramUtterance[]): SpeakerStats[] {
  const bySpeaker = new Map<number, SpeakerStats>();

  utterances.forEach((u, index) => {
    const stats = bySpeaker.get(u.speaker) ?? {
      speaker: u.speaker,
      turns: 0,
      words: 0,
      questions: 0,
      introHits: 0,
      firstIndex: index,
    };

    const lower = u.transcript.toLowerCase();
    stats.turns += 1;
    stats.words += u.transcript.split(/\s+/).filter(Boolean).length;
    stats.questions += (u.transcript.match(/\?/g) ?? []).length;
    stats.introHits += AGENT_SELF_INTRO.filter((p) => lower.includes(p)).length;

    bySpeaker.set(u.speaker, stats);
  });

  return [...bySpeaker.values()].sort((a, b) => a.speaker - b.speaker);
}

export function decideAgentSpeaker(
  utterances: DeepgramUtterance[]
): SpeakerDecision {
  const stats = collectStats(utterances);

  if (stats.length === 1) {
    return {
      agentSpeaker: stats[0]!.speaker,
      confidence: "low",
      reasons: [
        "Only one speaker was detected. Diarisation likely failed - review " +
          "the audio quality and correct transcript.json by hand.",
      ],
    };
  }

  const scores = new Map<number, number>();
  const reasons: string[] = [];
  for (const s of stats) scores.set(s.speaker, 0);

  const bump = (speaker: number, points: number) =>
    scores.set(speaker, (scores.get(speaker) ?? 0) + points);

  // Cue 1: whoever opens the call. On an outbound sales/support call this is
  // almost always the agent. Strong but not decisive on inbound calls.
  const opener = stats.reduce((a, b) => (a.firstIndex <= b.firstIndex ? a : b));
  bump(opener.speaker, 2);
  reasons.push(`Speaker ${opener.speaker} spoke first (+2).`);

  // Cue 2: self-introduction phrases. The strongest single signal we have.
  const topIntro = stats.reduce((a, b) => (a.introHits >= b.introHits ? a : b));
  if (topIntro.introHits > 0) {
    bump(topIntro.speaker, 3);
    reasons.push(
      `Speaker ${topIntro.speaker} used ${topIntro.introHits} agent-style ` +
        `self-introduction phrase(s) (+3).`
    );
  }

  // Cue 3: question rate. Agents drive the call by asking; customers answer.
  const byQuestionRate = [...stats].sort(
    (a, b) => b.questions / b.turns - a.questions / a.turns
  );
  const asker = byQuestionRate[0]!;
  if (asker.questions > 0) {
    bump(asker.speaker, 2);
    reasons.push(
      `Speaker ${asker.speaker} asked the most questions per turn ` +
        `(${(asker.questions / asker.turns).toFixed(2)}) (+2).`
    );
  }

  // Cue 4: talk time. Agents usually carry more of the conversation. Weakest
  // cue - a chatty customer inverts it - so it only breaks ties.
  const talker = stats.reduce((a, b) => (a.words >= b.words ? a : b));
  bump(talker.speaker, 1);
  reasons.push(`Speaker ${talker.speaker} spoke the most words (+1).`);

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [winner, winnerScore] = ranked[0]!;
  const runnerUpScore = ranked[1]?.[1] ?? 0;
  const margin = winnerScore - runnerUpScore;

  const confidence = margin >= 4 ? "high" : margin >= 2 ? "medium" : "low";
  reasons.push(
    `Winner: speaker ${winner} with ${winnerScore} points ` +
      `(margin ${margin} -> ${confidence} confidence).`
  );

  return { agentSpeaker: winner, confidence, reasons };
}
