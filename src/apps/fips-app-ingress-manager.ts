import { isIP } from "node:net";
import { createConnection, createServer, type Server, type Socket } from "node:net";

import type { AppRecord } from "./app-registry";

export type FipsEndpointState = "disabled" | "unavailable" | "listening" | "error" | "conflict";

export interface FipsAppEndpoint {
  enabled: boolean;
  nodeNpub: string | null;
  meshAddress: string | null;
  port: number | null;
  url: string | null;
  status: FipsEndpointState;
  error?: string;
}

export interface FipsNodeDescriptor {
  nodeNpub: string;
  meshAddress: string;
}

interface FipsIngressRecord {
  server: Server | null;
  sockets: Set<Socket>;
  endpoint: FipsAppEndpoint;
}

interface FipsIngressEnvironment {
  FIPS_APPS_ENABLED?: string;
  FIPS_CONTROL_SOCKET?: string;
  FIPS_NODE_NPUB?: string;
  FIPS_MESH_ADDRESS?: string;
}

export interface FipsAppIngressManagerOptions {
  env?: FipsIngressEnvironment;
  discover?: () => Promise<FipsNodeDescriptor>;
  serverFactory?: typeof createServer;
}

const DEFAULT_CONTROL_SOCKET = "/app/data/fips/control.sock";

function isEnabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function errorMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message
    .replace(/nsec1[023456789acdefghjklmnpqrstuvwxyz]+/gi, "[redacted-fips-secret]")
    .replace(/\b[0-9a-f]{64}\b/gi, "[redacted-secret]");
}

function endpointUrl(npub: string, port: number): string {
  return `http://${npub}.fips:${port}/`;
}

export function validateFipsNodeDescriptor(input: FipsNodeDescriptor): FipsNodeDescriptor {
  const nodeNpub = input.nodeNpub.trim();
  const meshAddress = input.meshAddress.trim().replace(/^\[|\]$/g, "");
  if (!/^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(nodeNpub)) {
    throw new Error("FIPS reported an invalid node npub");
  }
  if (isIP(meshAddress) !== 6 || !meshAddress.toLowerCase().startsWith("fd")) {
    throw new Error("FIPS reported an invalid mesh IPv6 address");
  }
  if (meshAddress === "::") {
    throw new Error("FIPS mesh listener cannot use the IPv6 wildcard address");
  }
  return { nodeNpub, meshAddress };
}

export function createTcpForwardingServer(
  targetPort: number,
  serverFactory: typeof createServer = createServer,
  sockets: Set<Socket> = new Set(),
): Server {
  return serverFactory((incoming: Socket) => {
    const target = createConnection({ host: "127.0.0.1", port: targetPort });
    sockets.add(incoming);
    sockets.add(target);
    incoming.once("close", () => sockets.delete(incoming));
    target.once("close", () => sockets.delete(target));
    incoming.setNoDelay(true);
    target.setNoDelay(true);
    incoming.once("error", () => target.destroy());
    target.once("error", () => incoming.destroy());
    incoming.pipe(target);
    target.pipe(incoming);
  });
}

async function discoverWithFipsctl(env: FipsIngressEnvironment): Promise<FipsNodeDescriptor> {
  const explicitNpub = env.FIPS_NODE_NPUB?.trim();
  const explicitAddress = env.FIPS_MESH_ADDRESS?.trim();
  if ((explicitNpub && !explicitAddress) || (!explicitNpub && explicitAddress)) {
    throw new Error("FIPS_NODE_NPUB and FIPS_MESH_ADDRESS must be set together");
  }
  if (explicitNpub && explicitAddress) {
    return validateFipsNodeDescriptor({ nodeNpub: explicitNpub, meshAddress: explicitAddress });
  }

  const socketPath = env.FIPS_CONTROL_SOCKET?.trim() || DEFAULT_CONTROL_SOCKET;
  const proc = Bun.spawn(["fipsctl", "--socket", socketPath, "show", "status"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`fipsctl show status failed${stderr.trim() ? `: ${errorMessage(stderr.trim()).slice(0, 240)}` : ""}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error("fipsctl show status returned invalid JSON");
  }
  const data = parsed.data && typeof parsed.data === "object"
    ? parsed.data as Record<string, unknown>
    : parsed;
  return validateFipsNodeDescriptor({
    nodeNpub: typeof data.npub === "string" ? data.npub : "",
    meshAddress: typeof data.ipv6_addr === "string" ? data.ipv6_addr : "",
  });
}

export class FipsAppIngressManager {
  private readonly env: FipsIngressEnvironment;
  private readonly discover: () => Promise<FipsNodeDescriptor>;
  private readonly serverFactory: typeof createServer;
  private readonly records = new Map<string, FipsIngressRecord>();
  private descriptor: FipsNodeDescriptor | null = null;
  private unavailableError: string | null = null;
  private initialized = false;

  constructor(options: FipsAppIngressManagerOptions = {}) {
    this.env = options.env ?? (Bun.env as FipsIngressEnvironment);
    this.discover = options.discover ?? (() => discoverWithFipsctl(this.env));
    this.serverFactory = options.serverFactory ?? createServer;
  }

  get enabled(): boolean {
    return isEnabled(this.env.FIPS_APPS_ENABLED);
  }

  async initialize(): Promise<void> {
    if (this.initialized && (!this.enabled || this.descriptor !== null)) return;
    this.initialized = true;
    if (!this.enabled) return;
    try {
      this.descriptor = validateFipsNodeDescriptor(await this.discover());
      this.unavailableError = null;
    } catch (error) {
      this.descriptor = null;
      this.unavailableError = errorMessage(error);
      console.warn(`[fips-apps] endpoints unavailable: ${this.unavailableError}`);
    }
  }

  getEndpoint(app: AppRecord): FipsAppEndpoint | null {
    if (!app.webApp) return null;
    const port = typeof app.webAppPort === "number" && app.webAppPort > 0 ? app.webAppPort : null;
    const existing = this.records.get(app.id)?.endpoint;
    if (existing) return { ...existing };
    if (!this.enabled) {
      return { enabled: false, nodeNpub: null, meshAddress: null, port, url: null, status: "disabled" };
    }
    if (!this.descriptor) {
      return {
        enabled: true,
        nodeNpub: null,
        meshAddress: null,
        port,
        url: null,
        status: "unavailable",
        ...(this.unavailableError ? { error: this.unavailableError } : {}),
      };
    }
    return {
      enabled: true,
      nodeNpub: this.descriptor.nodeNpub,
      meshAddress: this.descriptor.meshAddress,
      port,
      url: port ? endpointUrl(this.descriptor.nodeNpub, port) : null,
      status: port ? "unavailable" : "error",
      ...(port ? {} : { error: "Web app has no assigned port" }),
    };
  }

  async start(app: AppRecord): Promise<FipsAppEndpoint | null> {
    if (!app.webApp) return null;
    await this.initialize();
    await this.stop(app.id);
    const base = this.getEndpoint(app)!;
    if (!this.enabled || !this.descriptor || !base.port) {
      this.records.set(app.id, { server: null, sockets: new Set(), endpoint: base });
      return { ...base };
    }

    const sockets = new Set<Socket>();
    const server = createTcpForwardingServer(base.port, this.serverFactory, sockets);
    const endpoint: FipsAppEndpoint = {
      enabled: true,
      nodeNpub: this.descriptor.nodeNpub,
      meshAddress: this.descriptor.meshAddress,
      port: base.port,
      url: endpointUrl(this.descriptor.nodeNpub, base.port),
      status: "listening",
    };
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: this.descriptor!.meshAddress, port: base.port, ipv6Only: true }, () => {
          server.off("error", reject);
          resolve();
        });
      });
      this.records.set(app.id, { server, sockets, endpoint });
      server.on("error", (error) => {
        const current = this.records.get(app.id);
        if (current?.server !== server) return;
        current.endpoint.status = "error";
        current.endpoint.error = errorMessage(error);
        console.warn(`[fips-apps] ${app.id} listener failed: ${current.endpoint.error}`);
      });
      return { ...endpoint };
    } catch (error) {
      if (server.listening) server.close();
      const nodeError = error as NodeJS.ErrnoException;
      endpoint.status = nodeError.code === "EADDRINUSE" ? "conflict" : "error";
      endpoint.error = nodeError.code === "EADDRINUSE"
        ? `Port ${base.port} is already bound on the FIPS mesh address`
        : errorMessage(error);
      this.records.set(app.id, { server: null, sockets: new Set(), endpoint });
      console.warn(`[fips-apps] ${app.id}: ${endpoint.error}`);
      return { ...endpoint };
    }
  }

  async stop(appId: string): Promise<void> {
    const record = this.records.get(appId);
    if (!record) return;
    this.records.delete(appId);
    if (!record.server) return;
    for (const socket of record.sockets) socket.destroy();
    await new Promise<void>((resolve) => record.server!.close(() => resolve()));
  }

  async shutdown(): Promise<void> {
    await Promise.all(Array.from(this.records.keys(), (appId) => this.stop(appId)));
  }
}

export const fipsAppIngressManager = new FipsAppIngressManager();
