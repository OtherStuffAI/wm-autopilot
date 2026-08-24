/**
 * In-memory registry for runtime ports of running apps.
 * Stores the dynamically detected port for each app after start/restart.
 */

interface PortEntry {
  port: number;
  pid: number;
  updatedAt: string;
}

const DEFAULT_WINGMAN_PORT = 3600;

function getWingmanServerPort(): number {
  const parsed = Number.parseInt(Bun.env.PORT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WINGMAN_PORT;
}

export function isValidAppRuntimePort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port !== getWingmanServerPort();
}

class RuntimePortRegistry {
  private ports: Map<string, PortEntry> = new Map();

  /**
   * Set the runtime port for an app.
   * Overwrites any existing entry (newest wins).
   */
  set(appId: string, port: number, pid = 0): void {
    if (!isValidAppRuntimePort(port)) {
      console.warn(`[runtime-port-registry] Rejected invalid port ${port} for app ${appId}`);
      return;
    }
    this.ports.set(appId, {
      port,
      pid,
      updatedAt: new Date().toISOString(),
    });
    const msg = `SET port ${port} for app ${appId} (pid ${pid})`;
    console.log(`[runtime-port-registry] ${msg}`);
  }

  /**
   * Get the runtime port for an app.
   * Returns null if not found.
   */
  get(appId: string): number | null {
    const entry = this.ports.get(appId);
    return entry?.port ?? null;
  }

  /**
   * Get the full entry for an app (port, pid, timestamp).
   */
  getEntry(appId: string): PortEntry | null {
    return this.ports.get(appId) ?? null;
  }

  /**
   * Clear the runtime port for an app.
   * Called when app is stopped.
   */
  clear(appId: string): void {
    if (this.ports.delete(appId)) {
      console.log(`[runtime-port-registry] Cleared port for app ${appId}`);
    }
  }

  /**
   * Check if an app has a registered runtime port.
   */
  has(appId: string): boolean {
    return this.ports.has(appId);
  }

  /**
   * Get all registered ports (for debugging/status).
   */
  getAll(): Map<string, PortEntry> {
    return new Map(this.ports);
  }
}

export const runtimePortRegistry = new RuntimePortRegistry();
