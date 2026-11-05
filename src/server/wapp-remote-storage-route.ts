import { getRemoteStorageBroker } from "../wapps/remote-storage-runtime";
import type { RemoteStorageBroker } from "../wapps/remote-storage-broker";
import { readStorageJson, REMOTE_STORAGE_BROKER_PATH, RemoteStorageError, storageAssert } from "../wapps/remote-storage-contract";

export async function handleWappRemoteStorageRoute(input: { request: Request; url: URL;
  peer: { address: string } | null; broker?: RemoteStorageBroker }): Promise<Response | null> {
  if (input.url.pathname !== REMOTE_STORAGE_BROKER_PATH) return null;
  try {
    storageAssert(input.peer && new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]).has(input.peer.address)
      && new Set(["127.0.0.1", "localhost", "[::1]"]).has(input.url.hostname), "storage_loopback_required", 403);
    const broker = input.broker ?? getRemoteStorageBroker();
    if (!broker.configured()) return Response.json({ error: "not_found" }, { status: 404 });
    storageAssert(input.request.method === "POST" && !input.url.search && !input.url.hash, "storage_method_not_allowed", 405);
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(input.request.headers.get("authorization") ?? "")?.[1];
    storageAssert(token, "capability_required", 401);
    const signal = AbortSignal.any([input.request.signal, AbortSignal.timeout(15_000)]);
    return await broker.request(token, await readStorageJson(input.request, signal), signal);
  } catch (error) {
    const typed = error instanceof RemoteStorageError ? error : new RemoteStorageError("storage_unavailable", 503);
    return Response.json({ error: typed.code, ...(typed.code === "capability_invalid" ? { action: "managed_restart_required" } : {}) },
      { status: typed.status, headers: { "Cache-Control": "private, no-store" } });
  }
}
