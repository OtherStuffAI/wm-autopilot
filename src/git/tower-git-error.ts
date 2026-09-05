/** Only this typed error may cross the broker boundary; never forward response text. */
export class TowerGitError extends Error {
  constructor(readonly stage: string, readonly status: number, readonly code: string) {
    const hint = code === 'git_repository_not_found' || code.includes('grant') || code.includes('permission')
      ? 'Check the active workspace and ask its repository administrator to verify your actor grant.'
      : code.includes('reconcil') || code.includes('bootstrap') || code.includes('identity')
        ? 'Run forgejo bootstrap status; the Tower operator may need to repair the isolated reconcilers.'
        : 'Check the active Tower connection and forgejo bootstrap status.';
    super(`Tower Git ${stage} failed (HTTP ${status}, ${code}). ${hint}`);
  }
}

export async function towerGitResponseError(response: Response, stage: string): Promise<TowerGitError> {
  const body = await response.json().catch(() => null) as { code?: unknown } | null;
  // Restrict codes to the Tower namespace and short identifiers, excluding messages/secrets.
  const code = typeof body?.code === 'string' && /^git_[a-z_]{1,70}$/.test(body.code)
    ? body.code : 'git_request_failed';
  return new TowerGitError(stage, response.status, code);
}
