const convergedActivityCodes = new Set([
  'agent_activity_terminal',
  'stale_agent_activity_sequence',
]);

/** Tower already has an equal or newer authoritative activity snapshot. */
export function isConvergedAgentActivityError(error: unknown): boolean {
  const detailCode = (error as { detailCode?: unknown })?.detailCode;
  return typeof detailCode === 'string' && convergedActivityCodes.has(detailCode);
}
