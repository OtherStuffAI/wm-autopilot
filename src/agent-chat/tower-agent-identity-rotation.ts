import { createHash } from 'node:crypto';

import { finalizeEvent, nip19, type Event } from 'nostr-tools';

import { normaliseBackendBaseUrl, type FetchLike } from './tower-client';
import type { WorkspaceSubscriptionRecord } from './types';

export const TOWER_AGENT_IDENTITY_ROTATION_KIND = 33359;
export const TOWER_AGENT_IDENTITY_ROTATION_PROTOCOL = 'flightdeck_pg_agent_identity_rotation';

export interface TowerAgentRotationContext {
  towerOrigin: string;
  workspaceId: string;
  actorId: string;
  subscriptionCount: number;
}

export interface TowerAgentRotationRequest {
  url: string;
  body: string;
  payload: {
    rotation_id: string;
    old_npub: string;
    new_npub: string;
    proof: Event;
  };
}

export interface TowerAgentRotationResponse {
  status: 'completed' | 'idempotent_replay';
  actor_id: string;
  old_npub: string;
  new_npub: string;
  rotation_id: string;
  proof_event_id: string;
  completed_at: string;
  migration_counts: Record<string, number>;
  warnings: string[];
}

export class TowerAgentRotationError extends Error {
  constructor(
    message: string,
    readonly kind: 'known_failure' | 'transport_uncertain',
    readonly status: number | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

function diagnosticActorId(subscription: WorkspaceSubscriptionRecord): string | null {
  const value = subscription.lastAuthResult?.details?.actor_id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function resolveTowerAgentRotationContext(subscriptions: WorkspaceSubscriptionRecord[]): TowerAgentRotationContext | null {
  const towerSubscriptions = subscriptions.filter((subscription) => Boolean(subscription.workspaceId));
  if (towerSubscriptions.length === 0) return null;
  const contexts = towerSubscriptions.map((subscription) => {
    if (!subscription.workspaceId) throw new Error('Tower workspace subscription is missing workspace_id.');
    const actorId = diagnosticActorId(subscription);
    if (!actorId) throw new Error(`Tower workspace subscription ${subscription.subscriptionId} has no verified stable actor_id; refresh workspace access before rotating.`);
    const baseUrl = normaliseBackendBaseUrl(subscription.backendBaseUrl);
    return { towerOrigin: new URL(baseUrl).origin, workspaceId: subscription.workspaceId, actorId };
  });
  const identities = new Set(contexts.map((context) => `${context.towerOrigin}\0${context.actorId}`));
  if (identities.size !== 1) {
    throw new Error('Unsupported Tower rotation configuration: subscriptions resolve to distinct Tower services or stable actors.');
  }
  return { ...contexts[0]!, subscriptionCount: towerSubscriptions.length };
}

export function buildTowerAgentRotationRequest(input: {
  context: TowerAgentRotationContext;
  rotationId: string;
  oldNpub: string;
  newNpub: string;
  createdAt: number;
  expiresAt: number;
  newSecretKey: Uint8Array;
}): TowerAgentRotationRequest {
  const { context, rotationId, oldNpub, newNpub, createdAt, expiresAt } = input;
  const content = JSON.stringify({
    protocol: TOWER_AGENT_IDENTITY_ROTATION_PROTOCOL,
    version: 1,
    tower_origin: context.towerOrigin,
    workspace_id: context.workspaceId,
    actor_id: context.actorId,
    old_npub: oldNpub,
    new_npub: newNpub,
    rotation_id: rotationId,
    created_at: createdAt,
    expires_at: expiresAt,
  });
  const proof = finalizeEvent({
    kind: TOWER_AGENT_IDENTITY_ROTATION_KIND,
    created_at: createdAt,
    tags: [
      ['protocol', TOWER_AGENT_IDENTITY_ROTATION_PROTOCOL],
      ['tower_origin', context.towerOrigin],
      ['workspace_id', context.workspaceId],
      ['actor_id', context.actorId],
      ['old_npub', oldNpub],
      ['new_npub', newNpub],
      ['rotation_id', rotationId],
      ['expires_at', String(expiresAt)],
    ],
    content,
  }, input.newSecretKey);
  if (nip19.npubEncode(proof.pubkey) !== newNpub) throw new Error('Tower rotation proof signer does not match the replacement identity.');
  const payload = { rotation_id: rotationId, old_npub: oldNpub, new_npub: newNpub, proof };
  const url = `${context.towerOrigin}/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(context.workspaceId)}/agents/${encodeURIComponent(context.actorId)}/rotate-identity`;
  return { url, payload, body: JSON.stringify(payload) };
}

export function signTowerAgentRotationHttpRequest(request: TowerAgentRotationRequest, oldSecretKey: Uint8Array, createdAt: number): string {
  const event = finalizeEvent({
    kind: 27235,
    created_at: createdAt,
    tags: [
      ['u', request.url],
      ['method', 'POST'],
      ['payload', createHash('sha256').update(request.body, 'utf8').digest('hex')],
    ],
    content: '',
  }, oldSecretKey);
  return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}

export async function postTowerAgentRotation(input: {
  request: TowerAgentRotationRequest;
  authorization: string;
  fetchImpl?: FetchLike;
}): Promise<TowerAgentRotationResponse> {
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(input.request.url, {
      method: 'POST',
      headers: { authorization: input.authorization, 'content-type': 'application/json' },
      body: input.request.body,
    });
  } catch (error) {
    throw new TowerAgentRotationError(`Tower rotation response is uncertain: ${error instanceof Error ? error.message : String(error)}`, 'transport_uncertain');
  }
  const text = await response.text().catch(() => '');
  let payload: Record<string, unknown> = {};
  try { payload = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* handled below */ }
  if (!response.ok) {
    const code = typeof payload.code === 'string' ? payload.code : null;
    const message = typeof payload.error === 'string' ? payload.error : text || response.statusText || 'Tower rotation failed.';
    throw new TowerAgentRotationError(message, 'known_failure', response.status, code);
  }
  if (payload.status !== 'completed' && payload.status !== 'idempotent_replay') {
    throw new TowerAgentRotationError('Tower returned an unrecognized successful rotation response.', 'transport_uncertain', response.status);
  }
  const result = payload as unknown as TowerAgentRotationResponse;
  if (result.rotation_id !== input.request.payload.rotation_id
    || result.actor_id !== input.request.payload.proof.tags.find((tag) => tag[0] === 'actor_id')?.[1]
    || result.old_npub !== input.request.payload.old_npub
    || result.new_npub !== input.request.payload.new_npub
    || result.proof_event_id !== input.request.payload.proof.id) {
    throw new TowerAgentRotationError('Tower returned a successful response that does not match the staged rotation.', 'transport_uncertain', response.status);
  }
  return result;
}
