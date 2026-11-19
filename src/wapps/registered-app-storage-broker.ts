import { createHash, randomBytes } from "node:crypto";
import { nip19 } from "nostr-tools";
import type { WappStore } from "./wapp-store";
import { createWappNip98Authorization } from "./wapp-publishing-client";
import { RemoteStorageError, storageAssert, storageHash, storageUuid } from "./remote-storage-contract";
import { parseRegisteredStorageRequest, readRegisteredStorageBytes, readRegisteredStorageJson,
  REGISTERED_STORAGE_MAX_BYTES, REGISTERED_STORAGE_OPERATIONS, REGISTERED_STORAGE_PROTOCOL } from "./registered-app-storage-contract";

const ttl = 30 * 24 * 60 * 60 * 1000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
interface Binding {
  installationId: string; appId: string; ownerNpub: string; workspaceOwnerNpub: string;
  appNpub: string; bindingId: string; workspaceId: string | null; origin: string;
}
interface Capability { binding: Binding; bindings: Binding[]; expiresAt: number; }
export interface RegisteredAppStorageBrokerOptions {
  store: WappStore;
  forbiddenSigner: (npub: string) => boolean;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
}

export class RegisteredAppStorageBroker {
  private readonly capabilities = new Map<string, Capability>();
  private readonly now: () => number;
  private readonly fetchImpl: NonNullable<RegisteredAppStorageBrokerOptions["fetchImpl"]>;
  constructor(private readonly options: RegisteredAppStorageBrokerOptions) {
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private binding(installationId: string, appId: string): Binding {
    const wapp = this.options.store.get(installationId);
    storageAssert(wapp && wapp.id === installationId && wapp.wappInstallationId === installationId && wapp.appId === appId
      && wapp.recordState === "active" && wapp.status === "active" && wapp.appNpub
      && wapp.towerBindingId && wapp.towerBinding && wapp.towerBinding.id === wapp.towerBindingId
      && this.options.store.hasAppSigningKey(wapp.id), "storage_installation_invalid", 409);
    const tower = wapp.towerBinding;
    storageAssert(tower.workspaceOwnerNpub === wapp.workspaceOwnerNpub, "storage_workspace_mismatch", 409);
    for (const npub of [wapp.appNpub, wapp.ownerNpub, tower.workspaceOwnerNpub]) {
      storageAssert(nip19.decode(npub).type === "npub", "storage_identity_invalid", 409);
    }
    storageAssert(wapp.appNpub !== wapp.ownerNpub && wapp.appNpub !== tower.workspaceOwnerNpub
      && !this.options.forbiddenSigner(wapp.appNpub)
      && this.options.store.list().filter(row => row.recordState === "active" && row.status === "active" && row.appNpub === wapp.appNpub).length === 1,
    "storage_signer_not_isolated", 409);
    const url = new URL(tower.towerUrl);
    storageAssert(["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && url.pathname === "/" && !url.search && !url.hash, "storage_origin_invalid", 409);
    return { installationId, appId, ownerNpub: wapp.ownerNpub, workspaceOwnerNpub: tower.workspaceOwnerNpub,
      appNpub: wapp.appNpub, bindingId: tower.id, workspaceId: tower.workspaceId, origin: url.origin };
  }

  issue(installationId: string, appId: string, installationIds: string[] = [installationId]) {
    this.revokeApp(appId);
    for (const [key, value] of this.capabilities) if (value.expiresAt <= this.now()) this.capabilities.delete(key);
    const binding = this.binding(installationId, appId);
    const bindings = [...new Set([installationId, ...installationIds])].map(id => this.binding(id, appId));
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + ttl;
    this.capabilities.set(digest(token), { binding, bindings, expiresAt });
    return { token, binding: { ...binding, protocol: REGISTERED_STORAGE_PROTOCOL, maxObjectBytes: REGISTERED_STORAGE_MAX_BYTES },
      bindings: bindings.map(row => ({ ...row, protocol: REGISTERED_STORAGE_PROTOCOL, maxObjectBytes: REGISTERED_STORAGE_MAX_BYTES })),
      expiresAt: new Date(expiresAt).toISOString() };
  }

  revokeApp(appId: string): void {
    for (const [key, value] of this.capabilities) if (value.binding.appId === appId) this.capabilities.delete(key);
  }

  private validate(token: string, installationId?: string): Capability {
    const capability = this.capabilities.get(digest(token));
    storageAssert(capability && capability.expiresAt > this.now(), "capability_invalid", 401);
    for (const binding of capability.bindings) storageAssert(JSON.stringify(this.binding(binding.installationId, binding.appId)) === JSON.stringify(binding), "storage_installation_changed", 409);
    const binding = installationId === undefined ? capability.binding : capability.bindings.find(row => row.installationId === installationId);
    storageAssert(binding, "storage_installation_denied", 403);
    return { ...capability, binding };
  }

  private async signed(token: string, path: string, method: string, signal: AbortSignal, body?: unknown, installationId?: string): Promise<Response> {
    const { binding } = this.validate(token, installationId);
    const url = `${binding.origin}/api/v4/workspaces/${binding.workspaceOwnerNpub}/apps/${binding.appNpub}/storage${path}`;
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    const response = await this.options.store.withAppSigningKey(binding.installationId, async nsec => {
      this.validate(token);
      return this.fetchImpl(url, { method, signal, redirect: "manual", body: serializedBody,
        headers: { Authorization: createWappNip98Authorization({ url, method, nsec, serializedBody }),
          Accept: path.endsWith("/content") ? "application/octet-stream" : "application/json",
          ...(serializedBody === undefined ? {} : { "Content-Type": "application/json" }) } });
    });
    try {
      this.validate(token);
      storageAssert(response.status < 300 || response.status >= 400, "storage_redirect_denied", 502);
    } catch (error) { await response.body?.cancel(); throw error; }
    return response;
  }

  private metadata(value: Record<string, unknown>, binding: Binding, objectId?: string): Record<string, unknown> {
    storageAssert(value.protocol === REGISTERED_STORAGE_PROTOCOL && value.workspace_owner_npub === binding.workspaceOwnerNpub
      && value.app_npub === binding.appNpub && typeof value.object_id === "string" && storageUuid.test(value.object_id)
      && (!objectId || value.object_id === objectId) && value.is_public === false
      && typeof value.file_name === "string" && value.file_name.length > 0 && value.file_name.length <= 255
      && !/[\u0000-\u001f\u007f/\\]/.test(value.file_name)
      && typeof value.content_type === "string" && value.content_type.length <= 255
      && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value.content_type)
      && Number.isSafeInteger(value.size_bytes) && Number(value.size_bytes) > 0 && Number(value.size_bytes) <= REGISTERED_STORAGE_MAX_BYTES
      && typeof value.sha256_hex === "string" && storageHash.test(value.sha256_hex)
      && (value.completed_at === null || (typeof value.completed_at === "string" && Number.isFinite(Date.parse(value.completed_at)))),
    "storage_response_invalid", 502);
    return Object.fromEntries(["protocol", "workspace_owner_npub", "app_npub", "object_id", "file_name", "content_type", "size_bytes", "sha256_hex", "is_public", "completed_at"]
      .map(key => [key, value[key]]));
  }

  private async resultJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
    const body = await readRegisteredStorageJson(response, 16_384, signal);
    if (!response.ok) {
      // Preserve machine-readable Tower errors, never echo arbitrary server data or URLs.
      const code = typeof body.error === "string" && /^[a-z][a-z0-9_]{0,100}$/.test(body.error) ? body.error : "storage_destination_rejected";
      throw new RemoteStorageError(code, [400, 401, 403, 404, 409, 413, 429, 503].includes(response.status) ? response.status : 502);
    }
    return body;
  }

  async request(token: string, input: unknown, parentSignal?: AbortSignal): Promise<Response> {
    const operation = parseRegisteredStorageRequest(input);
    const capability = this.validate(token, operation.installationId);
    const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(parentSignal ? [parentSignal] : [])]);
    try {
      const descriptor = await this.resultJson(await this.signed(token, "/descriptor", "GET", signal, undefined, operation.installationId), signal);
      storageAssert(descriptor.protocol === REGISTERED_STORAGE_PROTOCOL && descriptor.workspace_owner_npub === capability.binding.workspaceOwnerNpub
        && descriptor.app_npub === capability.binding.appNpub && descriptor.private_only === true
        && Number.isSafeInteger(descriptor.max_object_bytes) && Number(descriptor.max_object_bytes) > 0
        && Number(descriptor.max_object_bytes) <= REGISTERED_STORAGE_MAX_BYTES && Array.isArray(descriptor.operations)
        && REGISTERED_STORAGE_OPERATIONS.every(op => (descriptor.operations as unknown[]).includes(op)), "storage_protocol_mismatch", 502);
      const headers = { "Cache-Control": "private, no-store" };
      this.validate(token);
      if (operation.path === "/descriptor") return Response.json(Object.fromEntries(
        ["protocol", "workspace_owner_npub", "app_npub", "max_object_bytes", "private_only", "operations"].map(key => [key, descriptor[key]])), { headers });
      const objectId = /^\/objects\/([^/]+)/.exec(operation.path)?.[1];
      // Re-read authoritative object metadata instead of trusting a consumer ledger or upload claim.
      const expected = objectId ? this.metadata(await this.resultJson(await this.signed(token, `/objects/${objectId}`, "GET", signal, undefined, operation.installationId), signal), capability.binding, objectId) : null;
      if (operation.method === "PUT") {
        const bytes = Buffer.from((operation.body as { base64_data: string }).base64_data, "base64");
        storageAssert(bytes.length === expected?.size_bytes && bytes.length <= Number(descriptor.max_object_bytes), "storage_size_mismatch");
        storageAssert(createHash("sha256").update(bytes).digest("hex") === expected.sha256_hex, "storage_hash_mismatch");
        storageAssert(expected.completed_at === null, "storage_object_immutable", 409);
      }
      if (operation.path.endsWith("/complete")) {
        const body = operation.body as Record<string, unknown>;
        storageAssert(body.size_bytes === expected?.size_bytes && body.sha256_hex === expected?.sha256_hex, "storage_completion_mismatch", 409);
      }
      if (operation.path === "/prepare") storageAssert(Number((operation.body as Record<string, unknown>).size_bytes) <= Number(descriptor.max_object_bytes), "storage_size_invalid", 413);
      const response = await this.signed(token, operation.path, operation.method, signal, operation.body, operation.installationId);
      if (operation.path.endsWith("/content") && response.ok) {
        storageAssert(expected?.completed_at, "storage_upload_incomplete", 409);
        const bytes = await readRegisteredStorageBytes(response, REGISTERED_STORAGE_MAX_BYTES, signal);
        if (operation.method !== "HEAD") storageAssert(bytes.length === expected.size_bytes
          && createHash("sha256").update(bytes).digest("hex") === expected.sha256_hex, "storage_content_mismatch", 502);
        this.validate(token);
        if (operation.method === "GET") return Response.json({ ...expected, bytes_base64: bytes.toString("base64") }, { headers });
        return new Response(null, { headers: { ...headers,
          "Content-Type": String(expected.content_type), "Content-Length": "0", "X-Storage-Size-Bytes": String(expected.size_bytes),
          "X-Content-Type-Options": "nosniff" } });
      }
      const result = this.metadata(await this.resultJson(response, signal), capability.binding, objectId);
      if (operation.path === "/prepare") {
        const body = operation.body as Record<string, unknown>;
        storageAssert(["file_name", "content_type", "size_bytes", "sha256_hex"].every(key => body[key] === result[key]), "storage_response_invalid", 502);
      }
      if (operation.path.endsWith("/complete")) storageAssert(result.completed_at, "storage_response_invalid", 502);
      if (expected) storageAssert(["file_name", "content_type", "size_bytes", "sha256_hex"].every(key => expected[key] === result[key]), "storage_response_invalid", 502);
      if (expected?.completed_at) storageAssert(expected.completed_at === result.completed_at, "storage_response_invalid", 502);
      this.validate(token);
      return Response.json(result, { headers });
    } catch (error) {
      if (error instanceof RemoteStorageError) throw error;
      throw new RemoteStorageError(signal.aborted ? "storage_timeout" : "storage_destination_unavailable", signal.aborted ? 504 : 502);
    }
  }
}
