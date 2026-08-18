# recording-1 - pushy outbound sales

| | |
|---|---|
| Source | https://www.youtube.com/watch?v=jlaetKa-Pt8 |
| Title | LIVE COLD CALL \| How to Overcome any Sales Objection like BATMAN |
| Duration used | 0:00 - 5:40 (full video, no trim needed) |
| Persona | Outbound B2B sales, UK, sales-training product |

## Why this recording

A single uncut live cold call from first hello to booked meeting, with no
narration over the top and no background music. It contains three real
objections - a sceptical "depends if you're selling anything good", a
confusion about what the product even is, and a scheduling conflict - which
gives the objection_handling section of the Agent Spec something real to
work from.

## Download command

```bash
yt-dlp -x --audio-format mp3 -o "examples/recording-1/audio.%(ext)s" \
  "https://www.youtube.com/watch?v=jlaetKa-Pt8"
```

## Notes

The agent uses an explicit permission-based opener ("I'll take 30 seconds,
you can decide, is that fair?") which should show up in the extracted
conversation_flow.opening and in evidence.signature_phrases.
