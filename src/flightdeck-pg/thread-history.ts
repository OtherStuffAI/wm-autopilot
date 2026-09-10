import { isDeepStrictEqual } from "node:util";

import {
  fetchFlightDeckPgChannelMessages,
  type FlightDeckPgMessagesResult,
} from "../agent-chat/tower-client.ts";

type HistoryInput = Omit<Parameters<typeof fetchFlightDeckPgChannelMessages>[0],
  "cursor" | "effectiveTranscript" | "strictPagination">;

// A broken server that issues endlessly unique cursors must fail, never truncate.
const maxHistoryPages = 10_000;

/** Read-only recovery; records (including inherited markers) remain untouched. */
export async function readFlightDeckHistory(input: HistoryInput): Promise<FlightDeckPgMessagesResult & {
  complete: true;
  page_size: number;
  pages_read: number;
}> {
  const limit = input.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Flight Deck history limit must be a page size from 1 to 500");
  }
  const effectiveTranscript = Boolean(input.threadId);
  const messages: FlightDeckPgMessagesResult["messages"] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let firstPage: FlightDeckPgMessagesResult | undefined;
  for (let pagesRead = 1; pagesRead <= maxHistoryPages; pagesRead += 1) {
    const page = await fetchFlightDeckPgChannelMessages({
      ...input, limit, cursor, effectiveTranscript, strictPagination: true,
    });
    if (effectiveTranscript && page.effective_transcript !== true) {
      throw new Error("Tower did not confirm effective transcript history; recovery is incomplete");
    }
    if (firstPage && (
      page.effective_transcript !== firstPage.effective_transcript
      || !isDeepStrictEqual(page.cursor_semantics, firstPage.cursor_semantics)
    )) {
      throw new Error("Tower history semantics changed between pages; recovery is incomplete");
    }
    firstPage ??= page;
    messages.push(...page.messages);
    if (page.next_cursor === null) {
      return {
        ...firstPage,
        messages,
        next_cursor: null,
        complete: true,
        page_size: limit,
        pages_read: pagesRead,
      };
    }
    if (seenCursors.has(page.next_cursor)) {
      throw new Error("Tower repeated a history cursor; recovery is incomplete");
    }
    seenCursors.add(page.next_cursor);
    cursor = page.next_cursor;
  }
  throw new Error(`Tower history exceeded ${maxHistoryPages} pages; recovery is incomplete`);
}
