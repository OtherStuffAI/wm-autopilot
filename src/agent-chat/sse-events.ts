export interface ParsedSseEvent {
  id: string | null;
  event: string;
  data: string;
}

export async function* parseSseEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ParsedSseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let eventId: string | null = null;
  let dataLines: string[] = [];

  const flush = async function* () {
    if (dataLines.length === 0) {
      eventName = 'message';
      return;
    }
    const payload = {
      id: eventId,
      event: eventName || 'message',
      data: dataLines.join('\n'),
    };
    eventName = 'message';
    eventId = null;
    dataLines = [];
    yield payload;
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

      if (line === '') {
        yield* flush();
      } else if (line.startsWith(':')) {
        // Ignore comments / heartbeats.
      } else if (line.startsWith('id:')) {
        eventId = line.slice(3).trim() || null;
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim() || 'message';
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }

      newlineIndex = buffer.indexOf('\n');
    }

    if (done) {
      break;
    }
  }

  if (buffer.trim().length > 0) {
    const line = buffer.trim();
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  yield* flush();
}
