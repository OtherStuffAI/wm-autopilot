import { describe, expect, test } from "bun:test";

import {
  buildTranscriptReplacement,
  buildVoiceNoteDraftBlock,
  removeVoiceNoteComments,
  replacePendingTranscriptMarker,
  replaceVoiceNoteLinkWithTranscript,
} from "./voice-note-draft.js";

describe("voice-note-draft", () => {
  test("replaces a pending voice-note block with a single transcript block", () => {
    const markerId = "voice_1";
    const label = "voice-note-1.webm";
    const publicPath = "/uploads/files/user/codex/voice-note-1.webm";
    const draftBlock = buildVoiceNoteDraftBlock(markerId, label, publicPath);
    const match = {
      raw: `[${label}](${publicPath})`,
      label,
      publicPath,
    };

    const nextDraft = replaceVoiceNoteLinkWithTranscript(
      draftBlock,
      match,
      "alpha transcript",
    );

    expect(removeVoiceNoteComments(nextDraft)).toBe(
      buildTranscriptReplacement(label, "alpha transcript"),
    );
  });

  test("does not duplicate transcript text when a transcript already exists in the block", () => {
    const markerId = "voice_2";
    const label = "voice-note-2.webm";
    const publicPath = "/uploads/files/user/codex/voice-note-2.webm";
    const transcript = buildTranscriptReplacement(label, "beta transcript");
    const draftWithTranscript = replacePendingTranscriptMarker(
      buildVoiceNoteDraftBlock(markerId, label, publicPath),
      markerId,
      transcript,
    );
    const match = {
      raw: `[${label}](${publicPath})`,
      label,
      publicPath,
    };

    const nextDraft = replaceVoiceNoteLinkWithTranscript(
      draftWithTranscript,
      match,
      "beta transcript",
    );

    expect(removeVoiceNoteComments(nextDraft)).toBe(transcript);
  });

  test("falls back to replacing a plain saved link when no voice-note block markers exist", () => {
    const label = "voice-note-3.webm";
    const publicPath = "/uploads/files/user/codex/voice-note-3.webm";
    const match = {
      raw: `[${label}](${publicPath})`,
      label,
      publicPath,
    };
    const draft = `Intro\n${match.raw}\nOutro`;

    const nextDraft = replaceVoiceNoteLinkWithTranscript(
      draft,
      match,
      "gamma transcript",
    );

    expect(nextDraft).toBe(
      `Intro\n${buildTranscriptReplacement(label, "gamma transcript")}\nOutro`,
    );
  });
});
