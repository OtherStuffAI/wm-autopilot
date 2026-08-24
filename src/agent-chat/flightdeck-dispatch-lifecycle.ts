export function isSessionWaitTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /^Timed out waiting for (?:accepted Direct Chat )?session .+(?: to produce a final response\.|: native Codex session was not captured; terminal output was rejected\.)$/u.test(message);
}
