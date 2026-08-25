const GENERIC_STARTUP_LINES = [
  /^\$ /,
  /^bun v\d/i,
  /^error: script ".+" exited with code \d+$/i,
  /^error when starting (?:preview )?server:?$/i,
  /^at\s+/,
  /^\d+\s*\|/,
  /^\^+$/,
  /^(?:errno|byteOffset|code):/i,
];

function cleanLogPrefix(line: string): string {
  return line
    .replace(/^\[(?:stdout|stderr)\]\s*/, "")
    .replace(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}:?\s*/, "")
    .trim();
}

export function summarizeAppStartupLogs(logs: string[], maxLength = 300): string | null {
  const meaningful = [...logs]
    .reverse()
    .map(cleanLogPrefix)
    .find((line) => line.length > 0 && !GENERIC_STARTUP_LINES.some((pattern) => pattern.test(line)));
  return meaningful ? meaningful.slice(0, maxLength) : null;
}
