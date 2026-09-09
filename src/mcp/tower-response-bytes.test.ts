import { expect, test } from "bun:test";
import { readTowerResponseBytes } from "./tower-response-bytes";

test("finite broker cancels oversized responses before buffering the rest", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(8)); },
    cancel() { cancelled = true; },
  });
  await expect(readTowerResponseBytes(new Response(stream), 10)).rejects.toThrow("byte limit");
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});
