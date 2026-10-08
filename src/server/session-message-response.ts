interface MessageResponseContext {
  messageStore: { listSessionMessages(sessionId: string): unknown[] };
  syncSessionMessages: (sessionId: string, force?: boolean) => Promise<unknown[]>;
}

export async function sessionMessageResponse(
  id: string,
  refresh: boolean,
  context: MessageResponseContext,
): Promise<Response> {
  const start = performance.now();
  try {
    const messages = refresh
      ? await context.syncSessionMessages(id, true)
      : context.messageStore.listSessionMessages(id);
    const response = Response.json({ id, messages });
    response.headers.set("server-timing", `session-history;dur=${(performance.now() - start).toFixed(2)};desc="${refresh ? "fresh" : "saved"}"`);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `Session history refresh failed: ${message}` }, { status: 502 });
  }
}
