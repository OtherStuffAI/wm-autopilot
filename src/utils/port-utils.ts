/**
 * Port availability checking utilities.
 */
import { Socket } from "node:net";

/**
 * Check if a port is available by attempting to bind to it.
 * Probe both loopback and wildcard IPv4/IPv6 sockets. Some platforms allow a
 * wildcard probe to bind alongside a loopback-only listener (and vice versa),
 * so checking only one address class can incorrectly report an occupied port
 * as free.
 * Returns true if the port is free on every supported probe target,
 * false if any target is already in use.
 */
export function isPortAvailable(port: number): boolean {
  const hostnames = ["127.0.0.1", "0.0.0.0", "::1", "::"];
  for (const hostname of hostnames) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let server: any = null;
    try {
      server = Bun.listen({
        hostname,
        port,
        socket: {
          data() {},
          close() {},
          open() {},
        },
      });
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError?.code === "EAFNOSUPPORT") {
        continue;
      }
      if (nodeError?.code !== "EADDRINUSE") {
        console.warn(`[port-utils] failed to probe port ${port} on ${hostname}: ${nodeError?.message ?? error}`);
      }
      return false;
    } finally {
      server?.stop(true);
    }
  }
  return true;
}

/**
 * Poll until a TCP port can be bound by a new process.
 */
export async function waitForAvailableTcpPort(
  port: number,
  options: { maxAttempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const { maxAttempts = 20, delayMs = 250 } = options;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isPortAvailable(port)) return true;
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

/**
 * Find the first available port from a list of candidates.
 * Checks both the provided exclusion set and actual system availability.
 * Returns undefined if no port is available.
 */
export function findAvailablePort(
  candidates: number[],
  exclude: Set<number> = new Set(),
): number | undefined {
  for (const port of candidates) {
    if (exclude.has(port)) {
      continue;
    }
    if (isPortAvailable(port)) {
      return port;
    }
  }
  return undefined;
}

/**
 * Detect which port a process is listening on using `ss`.
 * Returns the first TCP listening port found for the given PID, or null if none.
 */
export async function getListeningPortForPid(pid: number): Promise<number | null> {
  try {
    const proc = Bun.spawn(["ss", "-tlnp"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    // Parse ss output to find ports for this PID
    // Format: LISTEN 0 128 127.0.0.1:45063 0.0.0.0:* users:(("node",pid=2739695,fd=19))
    const pidPattern = new RegExp(`pid=${pid}\\b`);
    for (const line of output.split("\n")) {
      if (!pidPattern.test(line)) {
        continue;
      }
      // Extract port from local address (4th column)
      // Matches patterns like "127.0.0.1:45063" or "*:3000" or "[::]:3000"
      const match = line.match(/\s+[\w.:*\[\]]+:(\d+)\s+/);
      if (match && match[1]) {
        const port = parseInt(match[1], 10);
        if (Number.isFinite(port) && port > 0) {
          return port;
        }
      }
    }
    return null;
  } catch (error) {
    console.warn(`[port-utils] failed to detect port for PID ${pid}:`, error);
    return null;
  }
}

/**
 * Poll for a listening port for a PID with retries.
 * Useful after starting an app that may take time to bind to a port.
 */
export async function waitForListeningPort(
  pid: number,
  options: { maxAttempts?: number; delayMs?: number } = {},
): Promise<number | null> {
  const { maxAttempts = 5, delayMs = 500 } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const port = await getListeningPortForPid(pid);
    if (port !== null) {
      return port;
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

async function canConnectToTcpPort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

/**
 * Poll until a TCP port accepts localhost connections.
 */
export async function waitForTcpPort(
  port: number,
  options: { maxAttempts?: number; delayMs?: number; hosts?: string[] } = {},
): Promise<boolean> {
  const { maxAttempts = 20, delayMs = 250, hosts = ["127.0.0.1", "::1"] } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    for (const host of hosts) {
      if (await canConnectToTcpPort(port, host)) {
        return true;
      }
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}
