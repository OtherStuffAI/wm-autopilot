import { createConnection, createServer, type AddressInfo, type Server } from "node:net";
import { describe, expect, test } from "bun:test";

import type { AppRecord } from "./app-registry";
import {
  createTcpForwardingServer,
  FipsAppIngressManager,
  validateFipsNodeDescriptor,
} from "./fips-app-ingress-manager";

const NODE_NPUB = "npub1sx42mj99aql52aklsg70y2jmr95u7uz2p40k769aw46ppjv302kqkhmu5r";
const MESH_ADDRESS = "fd1b:4788:b7ab:7a43:6a61:1fc5:9fb1:e34c";

const app: AppRecord = {
  id: "mesh-app",
  label: "Mesh app",
  root: "/tmp/mesh-app",
  scripts: {},
  ownerNpub: "npub1owner",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  webApp: true,
  webAppPort: 41024,
};

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("FipsAppIngressManager", () => {
  test("derives a stable non-secret endpoint and binds only the exact mesh address", async () => {
    let listenOptions: Record<string, unknown> | null = null;
    let closed = false;
    const fakeServer = {
      once: () => fakeServer,
      on: () => fakeServer,
      off: () => fakeServer,
      listen: (options: Record<string, unknown>, callback: () => void) => {
        listenOptions = options;
        callback();
        return fakeServer;
      },
      close: (callback?: () => void) => {
        closed = true;
        callback?.();
        return fakeServer;
      },
    } as unknown as Server;
    const manager = new FipsAppIngressManager({
      env: { FIPS_APPS_ENABLED: "true" },
      discover: async () => ({ nodeNpub: NODE_NPUB, meshAddress: MESH_ADDRESS }),
      serverFactory: (() => fakeServer) as typeof createServer,
    });

    const endpoint = await manager.start(app);
    expect(listenOptions).toEqual({ host: MESH_ADDRESS, port: 41024, ipv6Only: true });
    expect(endpoint).toEqual({
      enabled: true,
      nodeNpub: NODE_NPUB,
      meshAddress: MESH_ADDRESS,
      port: 41024,
      url: `http://${NODE_NPUB}.fips:41024/`,
      status: "listening",
    });
    expect(JSON.stringify(endpoint)).not.toContain("nsec");

    await manager.stop(app.id);
    expect(closed).toBe(true);
  });

  test("fails closed and redacts secrets when discovery is unavailable", async () => {
    const manager = new FipsAppIngressManager({
      env: { FIPS_APPS_ENABLED: "true" },
      discover: async () => {
        throw new Error(`bad identity nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqd3g7k`);
      },
    });
    await manager.initialize();
    const endpoint = manager.getEndpoint(app);
    expect(endpoint).toMatchObject({ enabled: true, status: "unavailable", url: null });
    expect(JSON.stringify(endpoint)).not.toContain("nsec1");
    expect(endpoint?.error).toContain("[redacted-fips-secret]");
  });

  test("rejects wildcard and non-mesh listener addresses", () => {
    expect(() => validateFipsNodeDescriptor({ nodeNpub: NODE_NPUB, meshAddress: "::" })).toThrow();
    expect(() => validateFipsNodeDescriptor({ nodeNpub: NODE_NPUB, meshAddress: "2001:db8::1" })).toThrow();
  });

  test("rejects malformed public node identities", () => {
    expect(() => validateFipsNodeDescriptor({ nodeNpub: "npub1short", meshAddress: MESH_ADDRESS })).toThrow();
    expect(() => validateFipsNodeDescriptor({ nodeNpub: NODE_NPUB.toUpperCase(), meshAddress: MESH_ADDRESS })).toThrow();
  });
});

describe("FIPS TCP ingress", () => {
  test("forwards HTTP and upgrade-capable byte streams without rewriting", async () => {
    let received = "";
    const backend = createServer((socket) => {
      socket.on("data", (chunk) => {
        received += chunk.toString();
        if (received.includes("\r\n\r\n")) {
          socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\nframe-one");
        }
      });
    });
    await new Promise<void>((resolve) => backend.listen({ host: "127.0.0.1", port: 0 }, resolve));
    const port = (backend.address() as AddressInfo).port;
    const proxy = createTcpForwardingServer(port);
    await new Promise<void>((resolve) => proxy.listen({ host: "::1", port, ipv6Only: true }, resolve));

    try {
      const response = await new Promise<string>((resolve, reject) => {
        const client = createConnection({ host: "::1", port });
        let output = "";
        client.once("error", reject);
        client.on("data", (chunk) => {
          output += chunk.toString();
          if (output.includes("frame-one")) {
            client.end();
            resolve(output);
          }
        });
        client.once("connect", () => {
          client.write("GET /deep/assets/app.js?version=1 HTTP/1.1\r\nHost: mesh.example\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n");
        });
      });
      expect(received).toContain("GET /deep/assets/app.js?version=1 HTTP/1.1");
      expect(received).toContain("Host: mesh.example");
      expect(response).toContain("101 Switching Protocols");
      expect(response).toContain("frame-one");
    } finally {
      await closeServer(proxy);
      await closeServer(backend);
    }
  });
});
