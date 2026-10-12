import { createHash } from "node:crypto";
import {
  callCapabilityBroker,
  callCapabilityBrokerResponse,
  CapabilityRateLimitError,
  type CapabilityClientContext,
} from "../mcp/capability-client.ts";
import {
  boundedResponse,
  bodyTiming,
  TransientTransferError,
} from "./bounded-response.ts";
import { PAGE_MS, record, type JsonRecord } from "./record-sync-protocol.ts";

export class RecordSyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterMs = 0,
  ) {
    super(`Record-sync request failed (${status}): ${code}`);
  }
}
export interface TransferTiming {
  operation: string;
  signingMs: number;
  headersMs: number;
  bodyMs: number;
  selectedTransport: "https" | "fips";
  timingScope: "host-transport" | "client";
  parseMs: number;
  decodedBytes: number;
  retries: number;
}
export class RecordSyncClient {
  readonly timings: TransferTiming[] = [];
  brokerRequests = 0;
  private operationDeadline: number;
  readonly context: CapabilityClientContext;
  constructor(
    readonly baseContext: CapabilityClientContext,
    readonly wakeDeadline: number,
    readonly boundTransport: boolean,
    readonly appNpub: string,
    readonly timeoutMs = PAGE_MS,
    readonly signal?: AbortSignal,
    readonly random = Math.random,
  ) {
    this.operationDeadline = Math.min(Date.now() + timeoutMs, wakeDeadline);
    const fetchImpl = baseContext.fetch ?? fetch;
    this.context = {
      ...baseContext,
      fetch: ((input, init) =>
        boundedResponse(
          fetchImpl,
          input,
          {
            ...init,
            signal: AbortSignal.any([
              ...(init?.signal ? [init.signal] : []),
              ...(signal ? [signal] : []),
            ]),
          },
          Math.min(this.operationDeadline, wakeDeadline),
        )) as typeof fetch,
    };
  }
  remaining(): number {
    return this.wakeDeadline - Date.now();
  }
  async broker<T>(path: string, body: JsonRecord): Promise<T> {
    this.brokerRequests++;
    return callCapabilityBroker<T>(path, body, this.context);
  }
  async request(
    url: string,
    method: "GET" | "POST",
    body: string | undefined,
    operation: string,
  ): Promise<JsonRecord> {
    for (let attempt = 0; ; attempt++) {
      this.signal?.throwIfAborted();
      if (
        this.remaining() <= 0 ||
        (operation === "page" && this.remaining() < PAGE_MS)
      )
        throw new Error(
          "Wake budget deferred page; fewer than 30 seconds remain",
        );
      this.operationDeadline = Math.min(
        Date.now() + this.timeoutMs,
        this.wakeDeadline,
      );
      const started = performance.now();
      try {
        const actual = this.boundTransport
          ? String(
              (
                await this.broker<JsonRecord>("/api/mcp/wingman/flightdeck", {
                  action: "transport_prepare",
                  url,
                  method,
                  recordSync: true,
                })
              ).url ?? "",
            )
          : url;
        if (!actual) throw new Error("Missing selected Tower transport target");
        if (!this.boundTransport && new URL(actual).hostname.endsWith(".fips"))
          throw new Error("FIPS requires the bound host transport");
        const signed = await this.broker<{ token: string }>(
          "/api/mcp/capabilities/nip98",
          {
            url: actual,
            method,
            ...(method === "POST"
              ? {
                  bodyHash: createHash("sha256")
                    .update(body ?? "")
                    .digest("hex"),
                }
              : {}),
          },
        );
        const signedAt = performance.now();
        const headers = {
          accept: "application/json",
          authorization: signed.token,
          "x-flightdeck-pg-app-npub": this.appNpub,
          "content-type": "application/json",
          "accept-encoding": "identity",
        };
        let response: Response;
        if (this.boundTransport) {
          // Raw bounded JSON avoids a second base64 envelope and uses the selected host transport.
          this.brokerRequests++;
          response = await callCapabilityBrokerResponse(
            "/api/mcp/wingman/flightdeck",
            {
              action: "record_sync_request",
              url: actual,
              method,
              headers: Object.entries(headers),
              bodyBase64:
                body === undefined
                  ? null
                  : Buffer.from(body).toString("base64"),
            },
            this.context,
          );
        } else
          response = await this.context.fetch!(actual, {
            method,
            headers,
            ...(body === undefined ? {} : { body }),
          });
        const receivedAt = performance.now();
        const bytes = await response.text();
        const payload = record(JSON.parse(bytes));
        const parsedAt = performance.now();
        if (!response.ok) {
          const retry = response.headers.get("retry-after");
          const seconds = retry === null ? NaN : Number(retry);
          const delay = Number.isFinite(seconds)
            ? Math.max(0, seconds * 1000)
            : retry
              ? Math.max(0, Date.parse(retry) - Date.now())
              : 0;
          throw new RecordSyncHttpError(
            response.status,
            typeof payload.error === "string" &&
              /^[a-z_]{1,128}$/.test(payload.error)
              ? payload.error
              : "request_error",
            Number.isFinite(delay) ? delay : 0,
          );
        }
        const hostHeaders = response.headers.get("x-wingman-record-headers-ms");
        const hostBody = response.headers.get("x-wingman-record-body-ms");
        const hostTiming = this.boundTransport && hostHeaders !== null && hostBody !== null && Number.isFinite(Number(hostHeaders)) && Number.isFinite(Number(hostBody)) && Number(hostHeaders) >= 0 && Number(hostBody) >= 0;
        this.timings.push({
          operation,
          signingMs: signedAt - started,
          headersMs: hostTiming ? Number(hostHeaders) : bodyTiming(response)?.headersMs ?? receivedAt - signedAt,
          bodyMs: hostTiming ? Number(hostBody) : bodyTiming(response)?.bodyMs ?? 0,
          timingScope: hostTiming ? "host-transport" : "client",
          selectedTransport: new URL(actual).hostname.endsWith(".fips")
            ? "fips"
            : "https",
          parseMs: parsedAt - receivedAt,
          decodedBytes: Buffer.byteLength(bytes),
          retries: attempt,
        });
        return payload;
      } catch (error) {
        this.signal?.throwIfAborted();
        const status =
          error instanceof RecordSyncHttpError
            ? error.status
            : Number(record(error).status);
        const transient =
          error instanceof TransientTransferError ||
          error instanceof CapabilityRateLimitError ||
          status === 429 ||
          (status >= 500 && status <= 599);
        if (!transient || attempt >= 2) throw error;
        const retryAfter =
          error instanceof RecordSyncHttpError
            ? error.retryAfterMs
            : error instanceof CapabilityRateLimitError
              ? error.retryAfterMs
              : 0;
        const jitter = this.random() * Math.min(500 * 2 ** attempt, 5000);
        const delay = Math.max(retryAfter, jitter);
        if (this.remaining() < delay + PAGE_MS)
          throw new Error(
            "Retry deferred to next wake by Retry-After/time budget",
          );
        await new Promise<void>((resolve, reject) => {
          const cancel = () => {
            clearTimeout(timer);
            reject(new Error("Retry cancelled"));
          };
          const timer = setTimeout(() => {
            this.signal?.removeEventListener("abort", cancel);
            resolve();
          }, delay);
          this.signal?.addEventListener("abort", cancel, { once: true });
        });
      }
    }
  }
}
