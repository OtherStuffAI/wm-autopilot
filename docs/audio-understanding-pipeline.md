# Local audio-understanding pipeline

`audio-understanding` is a reusable Autopilot pipeline that turns an audio reference into a canonical, speaker-attributed transcript package. Its deterministic core is intentionally independent of meeting, podcast, graph, and agent-routing consumers.

The pipeline never places audio bytes or base64 in pipeline state and never falls back to a cloud API. It validates a reference, normalises audio with ffmpeg, runs separately configured timestamped STT and Nemotron 3 diarization commands, aligns words to speakers, applies conservative glossary corrections, writes artifacts, and optionally returns a concise result to a Flight Deck thread. Agent proofing and summary steps are visibly separate and disabled by default.

## Runtime prerequisites

Configure these variables on the Autopilot host:

| Variable | Purpose |
|---|---|
| `AUDIO_FFMPEG_COMMAND` | ffmpeg executable name or absolute path; defaults to `ffmpeg` |
| `AUDIO_STT_COMMAND` | Local timestamped-STT adapter executable |
| `AUDIO_STT_MODEL` | Existing local STT model path |
| `AUDIO_DIARIZATION_COMMAND` | Local Nemotron 3 diarization adapter executable |
| `AUDIO_DIARIZATION_MODEL` | Existing local Nemotron model path |
| `AUDIO_ALLOWED_LOCAL_ROOTS` | Comma-separated absolute roots from which local fixture/audio paths may be read |
| `AUDIO_ARTIFACT_ROOT` | Local artifact directory; defaults to `data/audio-understanding` |
| `AUDIO_ARTIFACT_RETENTION_HOURS` | Age bound for local run directories; defaults to 168 hours |

Preflight reports every missing binary or model and stops the run. Installation and model download are operator actions; the pipeline does neither.

Adapters are executed directly with argument arrays, never a shell. The flags below are the stable Autopilot wrapper contract, not a claim about a Nemotron, ONNX Runtime, or whisper.cpp native CLI. A small wrapper must translate them to the installed engine's tested invocation:

```text
STT:
  <command> --model <path> --audio <wav> --output-json <path> --word-timestamps
            [--language <language>] [--initial-prompt <comma-separated glossary>]

Diarization:
  <command> --model <path> --audio <wav> --output-json <path>
            [--speakers <1..8>]
```

STT JSON must contain `words: [{text,start,end,confidence?}]` and may contain `text` and `language`. Diarization JSON must contain `segments: [{speaker,start,end,confidence?}]`. The adapter boundary makes whisper.cpp, another local timestamped STT engine, and native/ONNX Nemotron runners replaceable without changing the pipeline schema.

## Input

```json
{
  "audioRef": "storage://11111111-1111-4111-8111-111111111111",
  "returnTo": {
    "workspaceId": "...",
    "scopeId": "...",
    "channelId": "...",
    "threadId": "..."
  },
  "options": {
    "language": "auto",
    "speakerCount": "auto",
    "glossary": ["Nostr", "Nemotron"],
    "speakerMapping": {},
    "correctTranscript": true,
    "proofreadTranscript": false,
    "summarise": false,
    "extractGraph": false,
    "downstreamPipelineId": null
  }
}
```

`returnTo` is required and all four UUID fields are validated. A local path is accepted only when it is absolute, exists, and is within `AUDIO_ALLOWED_LOCAL_ROOTS`. `file://`, relative, binary, data, and base64-like references are rejected.

Tower remains storage authority. `configureAudioUnderstandingAdapters` accepts narrow brokered `resolveStorage` and `publishArtifacts` adapters. Without that runtime wiring, `storage://` input and Tower publication fail or report the missing capability explicitly; controlled allowlisted local input still works. Deprecated Yoke/sync paths and raw signing keys are never used.

## Canonical output

The stable version-1 package contains:

- `speakers`: generic speaker labels unless `speakerMapping` was explicitly supplied;
- `words`: text, start/end seconds, confidence, and assigned speaker;
- `turns`: grouped speaker turns and source word indexes;
- `rawTranscript`: unchanged STT text;
- `correctedTranscript`: deterministic glossary-corrected turns;
- `corrections`: old/new text, reason, source, confidence, and word index;
- optional proofreader, summary, graph, and downstream outcomes remain separate from the canonical package;
- `artifacts`: content type, size, SHA-256, and reference;
- `engines`: engine/model identity;
- `metrics`: duration, processing time, real-time factor, word count, and speaker count;
- optional `downstream.requestedPipelineId`, which is an explicit handoff request rather than an implicit launch.

The glossary stage changes only single-token matches at or above its confidence threshold. It records every automatic change and leaves lower-confidence candidates untouched. The optional proofreader returns suggestions only; it cannot silently replace the deterministic transcript.

## Privacy and limitations

- Audio processing is local once the referenced object has been materialised.
- Nemotron supplies diarization only: it does not transcribe, correct spelling, or identify a person.
- Nemotron labels are anonymous and the supported caller hint is limited to eight speakers.
- Timestamp overlap assigns a word to the segment with greatest overlap; a nearest-segment rule handles timestamp gaps. Overlapping speech can still produce ambiguous word ownership because ordinary STT emits one word stream.
- Preserve separate microphone/computer tracks upstream when available. Version 1 accepts one mixed reference per run; callers can run each track independently before a consumer combines packages.
- Real accuracy, speed, memory use, and platform compatibility require validation with installed model binaries and representative audio. Fixture tests prove orchestration and packaging, not model quality.

Downstream pipelines should consume `result` and perform one bounded concern—meeting actions, podcast chapters, graph extraction, or routing. They should not modify `rawTranscript`, and should retain artifact and correction provenance.
