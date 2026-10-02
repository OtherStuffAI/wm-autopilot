export class FlightDeckPgResponseError extends Error {
  constructor(readonly status: number, readonly envelope: Record<string, unknown>, label: string) {
    super(`${label} failed (${status}): ${String(envelope.error ?? "Request failed")}`);
  }
}
