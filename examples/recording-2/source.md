# recording-2 - calm inbound support / receptionist

| | |
|---|---|
| Source | https://www.youtube.com/watch?v=faMKPA9_8Y0 |
| Title | AI Receptionist Demo: Book Appointments & Send SMS Confirmation \| Voca CIC |
| Duration used | 0:00 - 1:33 (trimmed; the rest of the video is product narration) |
| Persona | Inbound veterinary clinic receptionist, appointment booking |

## Why this recording

Deliberately chosen to contrast with recording-1. Inbound rather than
outbound, service rather than persuasion, no objections to overcome, and a
handoff to a human at the end instead of a close. If the persona extraction
is doing real work, this Agent Spec should differ from recording-1 on tone,
aggressiveness, persistence and conversation_flow.

## Download and trim commands

```bash
yt-dlp -x --audio-format mp3 -o "examples/recording-2/raw.%(ext)s" \
  "https://www.youtube.com/watch?v=faMKPA9_8Y0"
ffmpeg -i examples/recording-2/raw.mp3 -ss 00:00:00 -to 00:01:33 -c copy \
  examples/recording-2/audio.mp3
rm examples/recording-2/raw.mp3
```

## Known limitation

At 93 seconds this is shorter than the 2-10 minute range the PRD prefers,
and it yields roughly eight agent turns. That is enough to characterise tone
and flow but thin for objection handling, since the caller never objects.
Carry this into the evaluation write-up rather than treating the resulting
spec as equally well-evidenced as recording-1.
