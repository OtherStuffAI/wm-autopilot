import { parseSseEvents } from "./sse-events";
import type { FlightDeckPgEvent } from "./tower-client";

/** One consumer owns delivery: callers poll only after this stream closes or fails. */
export async function consumeTowerEventStream(input: {
  signal: AbortSignal;
  isCurrent: () => boolean;
  connect: () => Promise<Response>;
  deliver: (event: FlightDeckPgEvent) => Promise<void>;
}): Promise<void> {
  const response = await input.connect();
  if (input.signal.aborted || !input.isCurrent()) {
    await response.body?.cancel();
    return;
  }
  if (!response.ok || !response.body) throw new Error(`Tower event stream failed (${response.status})`);
  for await (const event of parseSseEvents(response.body)) {
    if (input.signal.aborted || !input.isCurrent()) return;
    if (event.event === "flightdeck_pg.error") throw new Error("Tower reported an event stream error");
    if (event.event !== "flightdeck_pg.event") continue;
    const data = JSON.parse(event.data);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Tower event stream returned invalid event data");
    await input.deliver(data as FlightDeckPgEvent);
  }
  if (!input.signal.aborted && input.isCurrent()) throw new Error("Tower event stream closed; recovering through polling");
}
