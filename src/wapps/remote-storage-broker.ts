import { createHash, randomBytes } from "node:crypto";
import type { WappStore } from "./wapp-store";
import { createWappNip98Authorization } from "./wapp-publishing-client";
import { readRemoteStorageGrants, type RemoteStorageGrant } from "./remote-storage-grants";
import { parseStorageOperation, readStorageJson, REMOTE_STORAGE_PREFIX, REMOTE_STORAGE_PROTOCOL, RemoteStorageError, storageAssert } from "./remote-storage-contract";
import { validateStorageResponse } from "./remote-storage-response";

interface Capability { appId: string; grant: RemoteStorageGrant; installation: string; expiresAt: number; }
export interface RemoteStorageBrokerOptions {
  store: WappStore;
  grants?: () => RemoteStorageGrant[];
  forbiddenSigner: (npub: string) => boolean;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}
const idleTtl = 30 * 24 * 60 * 60 * 1000;
function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
export class RemoteStorageBroker {
  private readonly capabilities = new Map<string, Capability>();
  readonly grants: () => RemoteStorageGrant[];
  readonly now: () => number;
  readonly fetchImpl: NonNullable<RemoteStorageBrokerOptions["fetchImpl"]>;
  constructor(private readonly options: RemoteStorageBrokerOptions) {
    this.grants = options.grants ?? readRemoteStorageGrants;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  configured() { return this.grants().length > 0; }
  private installation(grant: RemoteStorageGrant): string {
    const wapp = this.options.store.get(grant.installationId);
    storageAssert(wapp && wapp.recordState === "active" && wapp.status === "active" && wapp.appId === grant.appId
      && wapp.wappInstallationId === grant.installationId && wapp.ownerNpub === grant.ownerNpub
      && wapp.appNpub === grant.appNpub && wapp.towerBindingId === grant.towerBindingId && (grant.towerBindingId === null ? wapp.towerBinding === null : Boolean(wapp.towerBinding))
      && this.options.store.hasAppSigningKey(wapp.id), "storage_installation_invalid", 409);
    storageAssert(grant.appNpub !== wapp.ownerNpub && grant.appNpub !== wapp.workspaceOwnerNpub
      && !this.options.forbiddenSigner(grant.appNpub)
      && this.options.store.list().filter(row => row.recordState === "active" && row.status === "active" && row.appNpub === grant.appNpub).length === 1,
    "storage_signer_not_isolated", 409);
    return JSON.stringify({ id: wapp.id, installationId: wapp.wappInstallationId, appId: wapp.appId,
      owner: wapp.ownerNpub, workspaceOwner: wapp.workspaceOwnerNpub, appNpub: wapp.appNpub, binding: wapp.towerBinding });
  }
  issue(appId: string): { token: string; grant: RemoteStorageGrant; expiresAt: string } | null {
    this.revokeApp(appId);
    for (const [digest, record] of this.capabilities) if (record.expiresAt <= this.now()) this.capabilities.delete(digest);
    const grant = this.grants().find(g => g.appId === appId);
    if (!grant) return null;
    storageAssert(Date.parse(grant.expiresAt) > this.now(), "storage_grant_expired", 409);
    const installation = this.installation(grant);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Math.min(this.now() + idleTtl, Date.parse(grant.expiresAt));
    this.capabilities.set(hashToken(token), { appId, grant: structuredClone(grant), installation, expiresAt });
    return { token, grant, expiresAt: new Date(expiresAt).toISOString() };
  }
  revokeApp(appId: string) {
    for (const [key, capability] of this.capabilities) if (capability.appId === appId) this.capabilities.delete(key);
  }
  private validate(token: string): Capability {
    const capability = this.capabilities.get(hashToken(token));
    storageAssert(capability && capability.expiresAt > this.now(), "capability_invalid", 401);
    const current = this.grants().find(g => g.grantId === capability.grant.grantId);
    storageAssert(current && JSON.stringify(current) === JSON.stringify(capability.grant)
      && Date.parse(current.expiresAt) > this.now(), "storage_grant_revoked", 403);
    storageAssert(this.installation(current) === capability.installation, "storage_installation_changed", 409);
    return capability;
  }
  private async json(url: string, signal: AbortSignal, init: RequestInit = {}) {
    const response = await this.fetchImpl(url, { ...init, signal, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new RemoteStorageError("storage_redirect_denied", 502);
    }
    return { response, body: await readStorageJson(response, signal) };
  }
  async request(token: string, value: unknown, parentSignal?: AbortSignal): Promise<Response> {
    const capability = this.validate(token);
    const grant = capability.grant;
    const operation = parseStorageOperation(value, grant.maxObjectBytes);
    const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(parentSignal ? [parentSignal] : [])]);
    try {
      const health = await this.json(`${grant.origin}/health`, signal);
      storageAssert(health.response.ok && health.body.service_npub === grant.serviceNpub, "storage_service_identity_mismatch", 502);
      const descriptor = await this.json(`${grant.origin}${REMOTE_STORAGE_PREFIX}/descriptor`, signal);
      storageAssert(descriptor.response.ok && descriptor.body.protocol === REMOTE_STORAGE_PROTOCOL
        && Array.isArray(descriptor.body.features) && ["durable_idempotency", "quota_reservations", "private_objects",
          "immutable_completion", "revocable_downloads", "bounded_stream_uploads", "recovery_status", "publisher_receipts"].every(f => (descriptor.body.features as unknown[]).includes(f)),
      "storage_delegation_unsupported", 409);
      this.validate(token);
      const body = { installation_id: grant.installationId, app_id: grant.appId, revision: grant.revision,
        expected_service_npub: grant.serviceNpub, ...(operation.operation === "prepare"
          ? { idempotency_key: operation.idempotencyKey, sha256_hex: operation.sha256, size_bytes: operation.sizeBytes } : operation.operation === "status" && Object.hasOwn(operation, "cursor") ? { cursor: operation.cursor } : {}) };
      const path = `${REMOTE_STORAGE_PREFIX}/workspaces/${grant.workspaceId}/delegations/${grant.delegationId}/`
        + (operation.operation === "prepare" ? "prepare" : operation.operation === "status" && !Object.hasOwn(operation, "objectId")
          ? "status" : `objects/${"objectId" in operation ? operation.objectId : ""}/${operation.operation}`);
      const url = grant.origin + path;
      const serializedBody = JSON.stringify(body);
      const result = await this.options.store.withAppSigningKey(grant.installationId, async nsec => {
        // Callback-only existing app custody; never a session/profile/instance signer.
        this.validate(token);
        const authorization = createWappNip98Authorization({ url, method: "POST", nsec, serializedBody });
        return this.json(url, signal, { method: "POST", body: serializedBody,
          headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: authorization } });
      });
      this.validate(token);
      if (!result.response.ok) {
        const status = result.response.status;
        if (status === 401 || status === 403) throw new RemoteStorageError("storage_delegation_denied", status);
        const allowed = new Set(["storage_credits_required", "storage_budget_exhausted", "storage_idempotency_conflict", "storage_identity_mismatch",
          "storage_object_not_found", "storage_upload_incomplete", "storage_transfer_busy", "storage_size_invalid", "storage_billing_unconfigured"]);
        const code = typeof result.body.error === "string" && allowed.has(result.body.error) ? result.body.error : "storage_destination_rejected";
        throw new RemoteStorageError(code, [402, 404, 409, 413, 429, 503].includes(status) ? status : 502);
      }
      let response: Record<string, unknown>;
      try { response = validateStorageResponse(result.body, grant, operation, this.now()); }
      catch { throw new RemoteStorageError("storage_response_invalid", 502); }
      capability.expiresAt = Math.min(this.now() + idleTtl, Date.parse(grant.expiresAt));
      return Response.json(response, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      if (error instanceof RemoteStorageError) throw error;
      throw new RemoteStorageError(signal.aborted ? "storage_timeout" : "storage_destination_unavailable", signal.aborted ? 504 : 502);
    }
  }
}
