export const AGENT_OUTPUT_FORMATTING_FLAG_KEY = "pipeline_agent_output_formatting";

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const STRUCTURAL_LINE_PATTERN = /^(\s*(```|~~~|#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?|\|)|\s*$)/;
const URL_SPLIT_PATTERN = /(https?:\/\/|www\.)\S*$/i;
const WORD_SUFFIX_CONTINUATION_PATTERN = /^(ing|ed|er|ers|es|s|tion|tions|ment|ments|able|ible|ive|ous|ally|ity|ities|ize|izes|ise|ises|ertise|ertises)\b/i;

export function cleanAgentOutputText(value) {
  if (value === null || value === undefined) return "";
  const normalized = String(value)
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CONTROL_CHARACTER_PATTERN, "")
    .replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n").map((line) => line.replace(/[ \t]+$/g, ""));
  const cleaned = [];
  let inCodeFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      cleaned.push(line);
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence || cleaned.length === 0) {
      cleaned.push(line);
      continue;
    }
    if (shouldJoinSoftWrappedLine(cleaned[cleaned.length - 1], line)) {
      cleaned[cleaned.length - 1] = joinSoftWrappedLine(cleaned[cleaned.length - 1], line);
    } else {
      cleaned.push(line);
    }
  }

  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function shouldJoinSoftWrappedLine(previous, current) {
  const left = String(previous ?? "");
  const right = String(current ?? "");
  const leftTrimmed = left.trim();
  const rightTrimmed = right.trim();
  if (!leftTrimmed || !rightTrimmed) return false;
  if (STRUCTURAL_LINE_PATTERN.test(right)) return false;
  if (/\\$/.test(leftTrimmed)) return false;
  if (/[:.!?;)\]}]["']?$/.test(leftTrimmed)) return false;
  if (URL_SPLIT_PATTERN.test(leftTrimmed)) return true;
  if (hasUnclosedInlineCode(leftTrimmed)) return true;
  if (leftTrimmed.length >= 48) return true;
  return /^[a-z0-9"'([{]/i.test(rightTrimmed) && !/^\s{4,}\S/.test(right);
}

function joinSoftWrappedLine(previous, current) {
  const left = String(previous ?? "").trimEnd();
  const right = String(current ?? "").trimStart();
  if (URL_SPLIT_PATTERN.test(left)) return `${left}${right}`;
  if (shouldJoinWithoutSpace(left, right)) return `${left}${right}`;
  return `${left} ${right}`;
}

function shouldJoinWithoutSpace(left, right) {
  if (!/[A-Za-z]$/.test(left) || !/^[a-z]/.test(right)) return false;
  return WORD_SUFFIX_CONTINUATION_PATTERN.test(right);
}

function hasUnclosedInlineCode(value) {
  const matches = String(value).match(/`/g);
  return Boolean(matches && matches.length % 2 === 1);
}
