import { getRegisteredAppStorageBroker } from "../wapps/registered-app-storage-runtime";
import type { RegisteredAppStorageBroker } from "../wapps/registered-app-storage-broker";
import { readRegisteredStorageJson, REGISTERED_STORAGE_BROKER_PATH, REGISTERED_STORAGE_JSON_BYTES } from "../wapps/registered-app-storage-contract";
import { RemoteStorageError, storageAssert } from "../wapps/remote-storage-contract";

export async function handleWappRegisteredAppStorageRoute(input: {
  request: Request; url: URL; peer: { address: string } | null; broker?: RegisteredAppStorageBroker;
}): Promise<Response | null> {
  if (input.url.pathname !== REGISTERED_STORAGE_BROKER_PATH) return null;
  try {
    storageAssert(input.peer && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(input.peer.address)
      && ["127.0.0.1", "localhost", "[::1]"].includes(input.url.hostname), "storage_loopback_required", 403);
    storageAssert(input.request.method === "POST" && !input.url.search && !input.url.hash, "storage_method_not_allowed", 405);
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(input.request.headers.get("authorization") ?? "")?.[1];
    storageAssert(token, "capability_required", 401);
    const signal = AbortSignal.any([input.request.signal, AbortSignal.timeout(15_000)]);
    return await (input.broker ?? getRegisteredAppStorageBroker()).request(token,
      await readRegisteredStorageJson(input.request, REGISTERED_STORAGE_JSON_BYTES, signal), signal);
  } catch (error) {
    const typed = error instanceof RemoteStorageError ? error : new RemoteStorageError("storage_unavailable", 503);
    return Response.json({ error: typed.code, ...(typed.code === "capability_invalid" ? { action: "managed_restart_required" } : {}) },
      { status: typed.status, headers: { "Cache-Control": "private, no-store" } });
  }
}
