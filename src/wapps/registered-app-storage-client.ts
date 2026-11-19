import { parseRegisteredStorageRequest, REGISTERED_STORAGE_BROKER_PATH, type RegisteredStorageRequest } from "./registered-app-storage-contract";
import { storageAssert } from "./remote-storage-contract";

/** Server-only SDK: process capabilities must never be exposed to app users. */
export function createRegisteredAppStorageClient(env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch) {
  storageAssert(!env.WAPP_REGISTERED_APP_STORAGE_ERROR, "storage_runtime_unavailable", 503);
  const url = new URL(env.WAPP_REGISTERED_APP_STORAGE_BROKER_URL ?? "about:blank");
  const token = env.WAPP_REGISTERED_APP_STORAGE_CAPABILITY;
  storageAssert(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    && url.pathname === REGISTERED_STORAGE_BROKER_PATH && !url.username && !url.password && !url.search && !url.hash
    && typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token), "storage_runtime_unavailable", 503);
  let bindings: unknown;
  try { bindings = JSON.parse(env.WAPP_REGISTERED_APP_STORAGE_BINDINGS_JSON ?? "null"); } catch { bindings = null; }
  storageAssert(Array.isArray(bindings) && bindings.length > 0, "storage_runtime_unavailable", 503);
  return {
    bindings,
    async request(input: RegisteredStorageRequest, signal?: AbortSignal): Promise<Response> {
      parseRegisteredStorageRequest(input);
      return fetchImpl(url, { method: "POST", redirect: "error", signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(input) });
    },
  };
}
