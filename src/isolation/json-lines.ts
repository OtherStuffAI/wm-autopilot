/** Bounded transport framing. Every line is untrusted until its DTO is validated. */
export async function* jsonLines(stream: ReadableStream<Uint8Array>, totalLimit: number): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let pending = "";
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > totalLimit) throw new Error("Isolation transport output limit exceeded");
    pending += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line) yield JSON.parse(line);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) throw new Error("Incomplete isolation transport frame");
}
