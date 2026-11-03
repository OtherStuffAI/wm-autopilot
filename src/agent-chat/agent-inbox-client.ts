import { createHash, randomBytes } from 'node:crypto';
import { finalizeEvent } from 'nostr-tools';
import { buildFlightDeckPgUrl, fetchPgRequest, parseTowerError, type FlightDeckPgBotIdentity } from './tower-client';
import { prepareTowerRequestUrl } from './tower-transport-runtime';

/**
 * Client for Tower's strict agent notification inbox (capability `agent_notifications.v1`).
 *
 * Every request is signed by the ADDRESSED profile's own key with a fresh exact-request NIP-98 event (u incl. query,
 * method, payload for bodies, unique nonce). Requests are never retried with the same signature, there is no audience
 * parameter, and there is no fallback to `/events` on any error.
 */

export const AGENT_INBOX_CAPABILITY = 'agent_notifications_v1';

export interface AgentInboxEnvelope {
  id: string;
  seq: number;
  state: 'active' | 'revoked';
  kind?: string;
  reason?: string;
  source?: { type: string; id: string; version: number | null; channel_id: string | null; thread_id: string | null; task_id: string | null; doc_id: string | null };
  author_npub?: string | null;
  occurred_at?: string;
}
export interface AgentInboxPage { subscription_id: string; notifications: AgentInboxEnvelope[]; next_cursor: string; has_more: boolean }
export interface AgentInboxSubscription {
  recipient_npub: string;
  created: boolean;
  subscription: { id: string; consumer_id: string; floor_at: string; policy_version: number; acked_through_seq: number };
  cursor: string;
  gap?: { code: 'cursor_gap'; from_seq: number; through_seq: number; recovery_seq: number };
}
export type AgentInboxAckOutcome = 'handled' | 'suppressed' | 'source_gone' | 'failed_permanent';

export interface AgentInboxRequestContext {
  backendConnectionId?: string | null;
  subscriptionId?: string | null;
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: FlightDeckPgBotIdentity;
  signal?: AbortSignal;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Error classes drive the consumer's failure taxonomy. Authorization failures are never skipped. */
export type AgentInboxErrorClass = 'auth' | 'cursor' | 'gap' | 'source_gone' | 'relationship' | 'not_found' | 'transient' | 'unsupported' | 'malformed';
export class AgentInboxError extends Error {
  constructor(public status: number, public code: string, public errorClass: AgentInboxErrorClass, message: string, public details: Record<string, unknown> = {}) {
    super(message);
  }
}

export function classifyAgentInboxError(status: number, code: string | null): AgentInboxErrorClass {
  if (code === 'source_gone' || status === 410) return 'source_gone';
  if (code === 'relationship_removed' || code === 'access_revoked') return 'relationship';
  if (code === 'cursor_gap') return 'gap';
  if (code === 'invalid_cursor') return 'cursor';
  if (code === 'notification_not_found') return 'not_found';
  if (status === 404) return 'unsupported';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 429 || status >= 500) return 'transient';
  return 'malformed';
}

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Strict NIP-98: fresh event per request; stored keys sign locally, brokered identities via the capability broker. */
export async function signStrictNip98(context: AgentInboxRequestContext, url: string, method: string, body: string): Promise<string> {
  const identity = context.botIdentity;
  // An injected fetch (tests/in-process proofs) has no Tower transport to prepare: sign the URL it will receive.
  const actualUrl = context.fetchImpl
    ? url
    : 'towerTransport' in identity && identity.towerTransport
      ? (await identity.towerTransport.prepare(url)).toString()
      : await prepareTowerRequestUrl(url, { backendConnectionId: context.backendConnectionId, subscriptionId: context.subscriptionId });
  if ('signNip98' in identity) {
    // The broker binds the body hash when a body is present and always adds a unique nonce.
    return identity.signNip98({ url: actualUrl, method, body: body === '' ? undefined : body });
  }
  const tags = [['u', actualUrl], ['method', method], ['payload', sha256Hex(body)], ['nonce', randomBytes(16).toString('hex')]];
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags }, identity.botSecret);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

async function request<T>(context: AgentInboxRequestContext, method: 'GET' | 'POST', path: string, query: Record<string, string | number | null | undefined> = {}, payload?: unknown): Promise<{ json: T; response: Response }> {
  const url = buildFlightDeckPgUrl(context.backendBaseUrl, `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(context.workspaceId)}/agent-notifications${path}`, query);
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const authorization = await signStrictNip98(context, url, method, body);
  const init: RequestInit = {
    method,
    headers: { Accept: 'application/json', Authorization: authorization, 'x-flightdeck-pg-app-npub': context.appNpub, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body } : {}),
    signal: context.signal,
  };
  let response: Response;
  try {
    response = context.fetchImpl ? await context.fetchImpl(url, init) : await fetchPgRequest(context, url, init);
  } catch (error) {
    throw new AgentInboxError(0, 'network_error', 'transient', error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    const parsed = await parseTowerError(response, 'agent_notifications');
    const code = parsed.detailCode ?? `http_${response.status}`;
    throw new AgentInboxError(response.status, code, classifyAgentInboxError(response.status, parsed.detailCode), parsed.message, (parsed.details as Record<string, unknown>) ?? {});
  }
  return { json: method === 'GET' && path.includes('/attachments/') ? (undefined as T) : await response.json() as T, response };
}

export async function createAgentInboxSubscription(context: AgentInboxRequestContext, consumerId: string): Promise<AgentInboxSubscription> {
  return (await request<AgentInboxSubscription>(context, 'POST', '/subscriptions', {}, { consumer_id: consumerId })).json;
}

export async function listAgentInbox(context: AgentInboxRequestContext, cursor: string, limit = 50): Promise<AgentInboxPage> {
  const page = (await request<AgentInboxPage>(context, 'GET', '', { cursor, limit })).json;
  if (!page || !Array.isArray(page.notifications) || typeof page.next_cursor !== 'string') {
    throw new AgentInboxError(200, 'malformed_page', 'malformed', 'Agent inbox page is malformed');
  }
  return page;
}

export async function fetchAgentInboxContext<T = Record<string, any>>(context: AgentInboxRequestContext, notificationId: string): Promise<T> {
  return (await request<T>(context, 'GET', `/${encodeURIComponent(notificationId)}/context`)).json;
}

export async function fetchAgentInboxAttachment(context: AgentInboxRequestContext, notificationId: string, storageObjectId: string): Promise<Response> {
  return (await request<unknown>(context, 'GET', `/${encodeURIComponent(notificationId)}/attachments/${encodeURIComponent(storageObjectId)}`)).response;
}

export async function ackAgentInboxNotification(context: AgentInboxRequestContext, notificationId: string, input: { subscriptionId: string; outcome: AgentInboxAckOutcome; code?: string | null }) {
  return (await request<{ outcome: string; replayed: boolean; acked_through_seq: number }>(context, 'POST', `/${encodeURIComponent(notificationId)}/ack`, {}, {
    subscription_id: input.subscriptionId, outcome: input.outcome, ...(input.code ? { code: input.code } : {}),
  })).json;
}
