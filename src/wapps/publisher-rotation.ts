import { createWappAppNsec } from "./app-key";
import { TowerWappActivityRoutes, WappPublishingClient } from "./wapp-publishing-client";
import type { WappAppKeyMode, WappRecord } from "./types";
import type { WappStore } from "./wapp-store";

export interface WappPublisherRotationVerifierInput {
  wapp: WappRecord;
  pendingNpub: string;
  pendingNsec: string;
}

export type WappPublisherRotationVerifier = (
  input: WappPublisherRotationVerifierInput,
) => Promise<void>;

export interface WappPublisherRotationContext {
  store: WappStore;
  verifier?: WappPublisherRotationVerifier;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function appKeyMode(value: unknown): WappAppKeyMode | undefined {
  const normalized = text(value);
  return normalized === "generate" || normalized === "import" ? normalized : undefined;
}

function nsecInput(body: Record<string, unknown>): string | null {
  return text(body.wappNsec ?? body.wapp_nsec ?? body.WAPP_NSEC);
}

export async function verifyPublisherRotationWithTower(
  input: WappPublisherRotationVerifierInput,
): Promise<void> {
  const binding = input.wapp.towerBinding;
  if (!binding?.workspaceId) {
    throw new Error("Publisher rotation activation requires a Tower workspace ID binding");
  }
  const client = new WappPublishingClient({
    towerUrl: binding.towerUrl,
    workspaceId: binding.workspaceId,
    wappInstallationId: input.wapp.wappInstallationId,
    publisherNpub: input.pendingNpub,
    nsec: input.pendingNsec,
    routes: TowerWappActivityRoutes,
  });
  await client.refreshGrant();
}

export async function handleWappPublisherRotation(
  body: Record<string, unknown>,
  wapp: WappRecord,
  context: WappPublisherRotationContext,
): Promise<Response> {
  if (text(body.confirmWappInstallationId ?? body.confirm_wapp_installation_id) !== wapp.wappInstallationId) {
    return Response.json({ error: "confirmWappInstallationId must match the WApp installation" }, { status: 400 });
  }
  if (!wapp.towerBinding) {
    return Response.json({ error: "WApp is not Tower-backed" }, { status: 400 });
  }
  const phase = text(body.phase) ?? "stage";
  if (phase === "stage") {
    const nextNsec = createWappAppNsec(appKeyMode(body.appKeyMode ?? body.app_key_mode), nsecInput(body));
    const staged = context.store.stagePublisherKey(wapp.id, "import", nextNsec);
    return Response.json({ wapp: staged, rotation: "pending_tower_approval" });
  }
  if (phase !== "activate") {
    return Response.json({ error: "phase must be stage or activate" }, { status: 400 });
  }
  if (!wapp.pendingPublisherNpub || !context.store.hasAppSigningKey(wapp.id, true)) {
    return Response.json({ error: "WApp has no pending publisher key" }, { status: 409 });
  }
  await context.store.withAppSigningKey(wapp.id, async (pendingNsec) => {
    await (context.verifier ?? verifyPublisherRotationWithTower)({
      wapp, pendingNpub: wapp.pendingPublisherNpub!, pendingNsec,
    });
  }, true);
  const rotated = await context.store.activatePendingPublisherKey(wapp.id);
  return Response.json({ wapp: rotated, rotation: "activated" });
}
