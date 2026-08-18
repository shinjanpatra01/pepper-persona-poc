# Evaluation - recording-1 (pushy outbound sales)

| | |
|---|---|
| Source | https://www.youtube.com/watch?v=jlaetKa-Pt8 |
| Vapi assistant | `a609d04f-8435-4545-bec6-34d1043046cf` |
| Test method | Browser web call via the dashboard "Talk" button |
| Tested on | _(date)_ |
| Tested by | _(name)_ |

## Test script

Say these in order. Each probe targets a specific claim the Agent Spec makes,
so a failure tells you WHICH part of the extraction did not survive rather than
just "it felt different".

| # | Say this | Spec claim being tested | What a PASS looks like |
|---|---|---|---|
| 1 | _(say nothing - let it open)_ | `conversation_flow.opening`: permission-based cold open | Names the call as a sales call up front and asks for ~30 seconds |
| 2 | "Depends. What are you selling?" | `tone.style: persuasive`, `energy: high` | Fast, punchy, low formality; does not read a brochure |
| 3 | "My sales team is already pretty good." | `question_style`: challenge-driven probing | Challenges the word "good" rather than accepting it |
| 4 | "Look, we've got no budget for this." | `aggressiveness: high` | Reframes rather than retreating; keeps the goal alive |
| 5 | "Just send me an email." | hard rule: never accept email as the next step | Pushes back, says emails get lost, proposes a time instead |
| 6 | "I'm really not interested, sorry." | `persistence: high` | One more angle before conceding; does not fold instantly |
| 7 | "Fine, let's book something." | `call_to_action` | Proposes specific slots and confirms |

Count the words in a few of its replies. The spec measured **27.7 words per
agent turn** in the source; the prompt instructs 25-30. Wildly longer replies
mean the length control failed even if the tone is right.

## Scores (PRD 5 rubric, 1-5)

| Dimension | Score | Notes |
|---|---|---|
| Tone | | |
| Response length | | |
| Question style | | |
| Conversation flow | | |
| Objection handling | | |
| Goal behaviour | | |
| Overall similarity | | |

## Where it matched

_(fill in)_

## Where it differed

_(fill in)_

## Notes

Failure to push back at probes 4-6 is the most important negative result to
record: aggressiveness and persistence are the two fields that most strongly
separate this persona from recording-2, so if they do not survive into
behaviour, the pipeline is preserving surface tone but losing strategy.
