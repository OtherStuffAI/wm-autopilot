import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";

import { isPortAvailable, waitForTcpPort } from "./port-utils";

function listen(host: string, port = 0): Promise<import("node:net").Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

function close(server: import("node:net").Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

describe("isPortAvailable", () => {
  test("returns false for ports held by a loopback IPv4 listener", async () => {
    const server = await listen("127.0.0.1");
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      expect(port).toBeGreaterThan(0);
      expect(isPortAvailable(port)).toBe(false);
    } finally {
      await close(server);
    }
  });

  test("returns false for ports held by a wildcard IPv4 listener", async () => {
    const server = await listen("0.0.0.0");
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      expect(port).toBeGreaterThan(0);
      expect(isPortAvailable(port)).toBe(false);
    } finally {
      await close(server);
    }
  });

  test("returns false for ports held by a wildcard IPv6 listener", async () => {
    let server: import("node:net").Server | null = null;
    try {
      server = await listen("::");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "EAFNOSUPPORT") {
        return;
      }
      throw error;
    }

    try {
      const address = server.address();
      expect(address).toBeObject();
      const port = typeof address === "object" && address ? address.port : 0;
      expect(port).toBeGreaterThan(0);
      expect(isPortAvailable(port)).toBe(false);
    } finally {
      await close(server);
    }
  });

  test("returns true for a free ephemeral port after the listener closes", async () => {
    const server = await listen("127.0.0.1");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    expect(port).toBeGreaterThan(0);
    await close(server);
    expect(isPortAvailable(port)).toBe(true);
  });
});

describe("waitForTcpPort", () => {
  test("returns true when a localhost listener accepts connections", async () => {
    const server = await listen("127.0.0.1");
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      expect(port).toBeGreaterThan(0);
      await expect(waitForTcpPort(port, { maxAttempts: 1, hosts: ["127.0.0.1"] })).resolves.toBe(true);
    } finally {
      await close(server);
    }
  });

  test("returns false when no listener accepts connections", async () => {
    const server = await listen("127.0.0.1");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    expect(port).toBeGreaterThan(0);
    await close(server);

    await expect(waitForTcpPort(port, {
      maxAttempts: 1,
      delayMs: 1,
      hosts: ["127.0.0.1"],
    })).resolves.toBe(false);
  });
});
