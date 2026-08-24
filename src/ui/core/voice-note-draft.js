const AUDIO_LINK_PATTERN = /\[([^\]]+)\]\((\/uploads\/files\/[^)\s]+)\)/g;
const VOICE_NOTE_BLOCK_PATTERN = /<!--VOICE_NOTE:[^>]+:START-->[\s\S]*?<!--VOICE_NOTE:[^>]+:END-->/g;

export function sanitizeTranscriptLabel(value) {
  const cleaned = String(value ?? "").replace(/\s+/g, " ").trim();
  return cleaned || "voice note";
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getVoiceNoteMarkers(markerId) {
  return {
    start: `<!--VOICE_NOTE:${markerId}:START-->`,
    transcript: `<!--VOICE_NOTE:${markerId}:TRANSCRIPT_PENDING-->`,
    end: `<!--VOICE_NOTE:${markerId}:END-->`,
  };
}

export function buildVoiceNoteDraftBlock(markerId, label, publicPath) {
  const markers = getVoiceNoteMarkers(markerId);
  return `${markers.start}[${label}](${publicPath})\n${markers.transcript}\n${markers.end}`;
}

export function buildVoiceNoteBlockPattern(markerId) {
  const markers = getVoiceNoteMarkers(markerId);
  return new RegExp(`${escapeRegExp(markers.start)}[\\s\\S]*?${escapeRegExp(markers.end)}`, "g");
}

export function buildTranscriptReplacement(label, transcript) {
  return `Voice note transcript (${sanitizeTranscriptLabel(label)}):\n${transcript.trim()}`;
}

export function findVoiceNoteLinks(draft) {
  const text = typeof draft === "string" ? draft : "";
  const matches = [];
  AUDIO_LINK_PATTERN.lastIndex = 0;

  let match = AUDIO_LINK_PATTERN.exec(text);
  while (match) {
    const [raw, label, publicPath] = match;
    if (publicPath.includes("voice-note-")) {
      matches.push({ raw, label, publicPath });
    }
    match = AUDIO_LINK_PATTERN.exec(text);
  }

  return matches;
}

export function replacePendingTranscriptMarker(text, markerId, replacement) {
  const markers = getVoiceNoteMarkers(markerId);
  return String(text ?? "").replace(markers.transcript, replacement);
}

export function replaceVoiceNoteLinkWithTranscript(text, match, transcript) {
  const currentText = String(text ?? "");
  const replacement = buildTranscriptReplacement(match.label, transcript);
  const blockMatches = currentText.match(VOICE_NOTE_BLOCK_PATTERN) ?? [];
  const containingBlock = blockMatches.find((block) => block.includes(match.raw));
  if (containingBlock) {
    return currentText.replace(containingBlock, replacement);
  }
  return currentText.replace(match.raw, replacement);
}

export function removeVoiceNoteComments(text) {
  return String(text ?? "")
    .replace(/<!--VOICE_NOTE:[^>]+-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
