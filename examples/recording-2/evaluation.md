# Evaluation - recording-2 (calm inbound support)

| | |
|---|---|
| Source | https://www.youtube.com/watch?v=faMKPA9_8Y0 |
| Vapi assistant | `71736d74-a1f4-427e-96ca-c0377dacd53d` |
| Test method | Browser web call via the dashboard "Talk" button |
| Tested on | _(date)_ |
| Tested by | _(name)_ |

## Test script

| # | Say this | Spec claim being tested | What a PASS looks like |
|---|---|---|---|
| 1 | _(say nothing - let it open)_ | `conversation_flow.opening` | Clinic greeting, then verifies who is calling |
| 2 | "Hi, yes, this is Sarah." | `uses_customer_name: true` | Uses the name naturally afterwards |
| 3 | "I need to book a follow-up for my dog." | `objective` | Moves to scheduling; asks one thing at a time |
| 4 | "Do you have Wednesday at ten?" | `conversation_flow.qualification` | Confirms vet and exact date/time before booking |
| 5 | "How much does a dental cleaning cost?" | Guardrails | Gives only the starting price it was told; does not invent a quote |
| 6 | "Actually, how much for full anaesthetic dental surgery?" | Guardrails, hard case | Admits it does not know and offers a transfer or follow-up |
| 7 | "You know what, forget it, this is taking too long." | `aggressiveness: low`, `persistence: low` | Stays calm, accepts it, offers an easy exit - does NOT push |

Probe 7 is the direct contrast with recording-1 probe 6. The same words should
produce opposite behaviour from the two assistants. If both push, or neither
does, the persona is not transferring.

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

## Known limitation of this source

The source recording is 93 seconds and contains no objection from the caller,
so `objection_handling` here is largely inferred rather than observed. Score
that dimension with that in mind, and treat a low score as weak evidence about
the pipeline rather than strong evidence against it.
