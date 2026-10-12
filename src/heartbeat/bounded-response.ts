import { MAX_BYTES } from "./record-sync-protocol.ts";

export class TransientTransferError extends Error {}
export class DecodedResponseTooLarge extends Error {}
export interface BodyTiming {
  headersMs: number;
  bodyMs: number;
  decodedBytes: number;
}
const metrics = new WeakMap<Response, BodyTiming>();
export function bodyTiming(response: Response): BodyTiming | undefined {
  return metrics.get(response);
}

/** Count decoded stream bytes before parsing, including compressed responses. */
export async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const aborted = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) aborted();
  try {
    while (true) {
      if (signal.aborted)
        throw new TransientTransferError("Response transfer cancelled");
      const { done, value } = await reader.read();
      if (signal.aborted)
        throw new TransientTransferError("Response transfer cancelled");
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        void reader.cancel().catch(() => {});
        throw new DecodedResponseTooLarge(
          "Decoded response exceeds 1 MiB; no cursor advanced",
        );
      }
      chunks.push(value);
    }
    const result = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } catch (error) {
    if (
      error instanceof DecodedResponseTooLarge ||
      error instanceof TransientTransferError
    )
      throw error;
    throw new TransientTransferError("Response body transfer failed");
  } finally {
    signal.removeEventListener("abort", aborted);
    reader.releaseLock();
  }
}

export async function boundedResponse(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  deadline: number,
): Promise<Response> {
  const started = performance.now();
  const controller = new AbortController();
  const external = init?.signal;
  const abort = () => controller.abort();
  external?.addEventListener("abort", abort, { once: true });
  if (external?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled: (() => void) | undefined;
  try {
    return await Promise.race([
      (async () => {
        if (controller.signal.aborted)
          throw new TransientTransferError("Request cancelled");
        let response: Response;
        try {
          response = await fetchImpl(input, {
            ...init,
            signal: controller.signal,
            redirect: "error",
          });
        } catch {
          throw new TransientTransferError("Selected transport request failed");
        }
        const receivedHeaders = performance.now();
        const body = await readBoundedBody(response, controller.signal);
        const output = new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        metrics.set(output, {
          headersMs: receivedHeaders - started,
          bodyMs: performance.now() - receivedHeaders,
          decodedBytes: body.byteLength,
        });
        return output;
      })(),
      new Promise<never>((_, reject) => {
        cancelled = () => reject(new TransientTransferError("Request cancelled"));
        controller.signal.addEventListener("abort", cancelled, { once: true });
        if (controller.signal.aborted) cancelled();
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            reject(
              new TransientTransferError("Full-body request deadline exceeded"),
            );
            controller.abort();
          },
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (cancelled) controller.signal.removeEventListener("abort", cancelled);
    external?.removeEventListener("abort", abort);
  }
}
