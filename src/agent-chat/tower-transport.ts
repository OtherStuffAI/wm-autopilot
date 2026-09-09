import { requestNativeFips, resolveNativeFipsDestination } from "../apps/native-fips-request";
import { effectiveTowerEndpoint, type TowerTransportConfig } from "./tower-transport-config";

export interface TowerTransportDiagnostics {
  selectedTransport: "https" | "fips";
  effectiveTransport: "https" | "fips" | null;
  verifiedServiceNpub: string | null;
  lastSuccessfulRequestAt: string | null;
  lastSuccessfulEventAt: string | null;
  lastError: string | null;
  reconnectState: "idle" | "connecting" | "connected" | "error";
  counters: Record<"https" | "fips", { requests: number; errors: number }>;
}

export interface TowerTransportDependencies {
  fetch?: typeof fetch;
  resolveMesh?: typeof resolveNativeFipsDestination;
  requestMesh?: typeof requestNativeFips;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
}

export class TowerTransport {
  readonly diagnostics: TowerTransportDiagnostics;
  private readonly generation = new AbortController();
  private verified: { address: string; expires: number } | null = null;
  private verification: Promise<string> | null = null;

  constructor(readonly logicalEndpoint: string, readonly config: TowerTransportConfig,
    private readonly dependencies: TowerTransportDependencies = {}) {
    this.diagnostics = {
      selectedTransport: config.mode, effectiveTransport: null, verifiedServiceNpub: null,
      lastSuccessfulRequestAt: null, lastSuccessfulEventAt: null, lastError: null, reconnectState: "idle",
      counters: { https: { requests: 0, errors: 0 }, fips: { requests: 0, errors: 0 } },
    };
  }

  close(): void {
    this.generation.abort(new Error("Tower transport selection changed"));
    this.verified = null;
  }

  target(input: string | URL): URL {
    const url = new URL(input);
    const allowed = [this.logicalEndpoint, this.config.httpsEndpoint, this.config.fipsEndpoint]
      .filter((entry): entry is string => Boolean(entry)).map((entry) => new URL(entry).origin);
    if (!allowed.includes(url.origin) || url.username || url.password || url.hash) {
      throw new Error("Tower destination is outside the approved connection");
    }
    const endpoint = new URL(effectiveTowerEndpoint(this.config));
    url.protocol = endpoint.protocol;
    url.host = endpoint.host;
    return url;
  }

  async prepare(input: string | URL, signal?: AbortSignal | null): Promise<URL> {
    const url = this.target(input);
    this.generation.signal.throwIfAborted();
    if (this.config.mode === "fips") await this.verify(signal);
    return url;
  }

  event(): void {
    this.diagnostics.lastSuccessfulEventAt = new Date().toISOString();
    this.diagnostics.reconnectState = "connected";
  }

  private signal(signal?: AbortSignal | null): AbortSignal {
    return AbortSignal.any([this.generation.signal, AbortSignal.timeout(this.dependencies.timeoutMs ?? 30_000), ...(signal ? [signal] : [])]);
  }

  private failure(error: unknown): void {
    this.diagnostics.counters[this.config.mode].errors += 1;
    this.diagnostics.effectiveTransport = null;
    this.diagnostics.reconnectState = "error";
    // Never include request headers, signatures, response bodies or broker tokens.
    this.diagnostics.lastError = error instanceof Error ? error.message.slice(0, 240) : "Tower transport failed";
  }

  async verify(signal?: AbortSignal | null): Promise<string> {
    this.generation.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (this.verified && this.verified.expires > Date.now()) return this.verified.address;
    if (this.verification) return waitForVerification(this.verification, signal);
    const check = async () => {
      this.diagnostics.reconnectState = "connecting";
      const bounded = this.signal();
      try {
        const endpoint = effectiveTowerEndpoint(this.config);
        const address = await (this.dependencies.resolveMesh ?? resolveNativeFipsDestination)(endpoint, bounded);
        bounded.throwIfAborted();
        this.diagnostics.counters.fips.requests += 1;
        const response = await (this.dependencies.requestMesh ?? requestNativeFips)(new URL("/health", endpoint), address, { signal: bounded });
        if (!response.ok) throw new Error(`Tower mesh health failed (${response.status})`);
        const health = await response.json() as { service_npub?: string };
        if (health.service_npub !== this.config.expectedServiceNpub) throw new Error("Tower service identity mismatch on approved mesh endpoint");
        bounded.throwIfAborted();
        this.verified = { address, expires: Date.now() + 30_000 };
        this.diagnostics.verifiedServiceNpub = health.service_npub;
        return address;
      } catch (error) {
        this.verified = null;
        this.diagnostics.verifiedServiceNpub = null;
        this.failure(error);
        throw error;
      }
    };
    this.verification = check();
    const pending = this.verification;
    void pending.finally(() => { if (this.verification === pending) this.verification = null; }).catch(() => {});
    return waitForVerification(pending, signal);
  }

  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = await this.prepare(input, init.signal);
    const stream = new Headers(init.headers).get("accept")?.includes("text/event-stream");
    // SSE has a bounded header wait; the caller owns its ongoing lifetime.
    const controller = new AbortController();
    let timeout = setTimeout(() => controller.abort(new Error("Tower request timed out")), this.dependencies.timeoutMs ?? 30_000);
    const signal = AbortSignal.any([this.generation.signal, controller.signal, ...(init.signal ? [init.signal] : [])]);
    this.diagnostics.counters[this.config.mode].requests += 1;
    try {
      const response = this.config.mode === "fips"
        ? await (this.dependencies.requestMesh ?? requestNativeFips)(url, await this.verify(signal), { ...init, signal })
        : await (this.dependencies.fetch ?? fetch)(url, { ...init, signal, redirect: "manual" });
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        await response.body?.cancel();
        throw new Error("Tower redirects are forbidden");
      }
      if (!response.ok) this.failure(new Error(`Tower request failed (${response.status})`));
      else {
        this.diagnostics.effectiveTransport = this.config.mode;
        this.diagnostics.lastSuccessfulRequestAt = new Date().toISOString();
        this.diagnostics.lastError = null;
        this.diagnostics.reconnectState = "connected";
      }
      const refreshStreamDeadline = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => controller.abort(new Error("Tower event stream heartbeat timed out")), this.dependencies.streamIdleTimeoutMs ?? 45_000);
      };
      if (stream) refreshStreamDeadline();
      if (!response.body) clearTimeout(timeout);
      if (!response.body) return response;
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        pull: async (output) => {
          try {
            const chunk = await reader.read();
            if (chunk.done) { clearTimeout(timeout); output.close(); }
            else { if (stream) refreshStreamDeadline(); output.enqueue(chunk.value); }
          } catch (error) { clearTimeout(timeout); this.failure(error); output.error(error); }
        },
        cancel: async (reason) => { clearTimeout(timeout); controller.abort(reason); await reader.cancel(reason); },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      clearTimeout(timeout);
      this.failure(error);
      throw error;
    }
  }
}

function waitForVerification(pending: Promise<string>, signal?: AbortSignal | null): Promise<string> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
