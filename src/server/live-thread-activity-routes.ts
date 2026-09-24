import type { ChatInterceptStateRecord } from '../agent-chat/types';
import type { DirectChatTurnRecord } from '../agent-chat/direct-chat-turn-store';
import { liveThreadActivityHub, type LiveThreadActivityHub, type LiveThreadActivityRecord } from '../agent-chat/live-thread-activity';
import { DelegationScopes, resolveOwnerAccess } from '../auth/delegation-access';
import type { RequestAuthContext } from '../auth/request-context';
import type { WorkspaceDelegationStore } from '../storage/workspace-delegation-store';

interface InterceptStore {
  listAll(): ChatInterceptStateRecord[];
}

interface TurnStore {
  getPending(routingKey: string): DirectChatTurnRecord | null;
}

export interface LiveThreadActivityRoutesContext {
  workspaceDelegationStore: WorkspaceDelegationStore;
  interceptStore: InterceptStore;
  turnStore: TurnStore;
  hub?: LiveThreadActivityHub;
  keepaliveMs?: number;
}

interface RequestedContext {
  ownerNpub: string;
  workspaceId: string;
  towerServiceNpub: string;
  sourceAppNpub: string;
  channelId: string;
  threadId: string;
  agentNpub: string;
}

const headers = { 'cache-control': 'no-store' };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers });
}

function route(pathname: string): { ownerNpub: string; threadId: string; resource: 'snapshot' | 'events' } | null {
  const match = pathname.match(/^\/api\/owners\/([^/]+)\/control-plane\/v1\/live-threads\/([^/]+)\/(snapshot|events)$/);
  if (!match) return null;
  try {
    return { ownerNpub: decodeURIComponent(match[1]!), threadId: decodeURIComponent(match[2]!), resource: match[3] as 'snapshot' | 'events' };
  } catch { return null; }
}

function requestContext(url: URL, ownerNpub: string, threadId: string): RequestedContext | null {
  const value = (name: string) => String(url.searchParams.get(name) ?? '').trim();
  const context = {
    ownerNpub,
    workspaceId: value('workspace_id'),
    towerServiceNpub: value('tower_service_npub'),
    sourceAppNpub: value('app_npub'),
    channelId: value('channel_id'),
    threadId,
    agentNpub: value('agent_npub'),
  };
  return Object.values(context).every(Boolean) ? context : null;
}

function resolveIntercept(ctx: LiveThreadActivityRoutesContext, requested: RequestedContext): ChatInterceptStateRecord | null {
  return ctx.interceptStore.listAll().find((record) =>
    record.workspaceOwnerNpub === requested.ownerNpub
    && record.workspaceId === requested.workspaceId
    && record.towerServiceNpub === requested.towerServiceNpub
    && record.sourceAppNpub === requested.sourceAppNpub
    && record.channelId === requested.channelId
    && record.threadId === requested.threadId
    && record.botNpub === requested.agentNpub) ?? null;
}

function project(record: LiveThreadActivityRecord, intercept: ChatInterceptStateRecord) {
  return {
    routing_key: intercept.routingKey,
    session_generation: intercept.sessionGeneration ?? 1,
    turn_id: record.turnId,
    sequence: record.sequence,
    cursor: String(record.cursor),
    lifecycle: record.lifecycle,
    commentary: record.commentary ?? null,
    activity_status: record.activityStatus ?? null,
    timestamp: record.timestamp,
  };
}

function isCurrent(record: LiveThreadActivityRecord, intercept: ChatInterceptStateRecord, turn: DirectChatTurnRecord | null): boolean {
  return Boolean(turn && record.turnId === turn.turnId && record.sessionId === intercept.sessionId);
}

export async function handleLiveThreadActivityApi(
  request: Request,
  url: URL,
  method: string,
  auth: RequestAuthContext,
  ctx: LiveThreadActivityRoutesContext,
): Promise<Response | null> {
  const matched = route(url.pathname);
  if (!matched) return null;
  if (method !== 'GET') return json({ error: 'method-not-allowed' }, 405);
  if (auth.authMethod !== 'nip98') return json({ error: 'nip98-authentication-required' }, 401);
  const access = resolveOwnerAccess(auth, matched.ownerNpub,
    ctx.workspaceDelegationStore.findActiveDelegation.bind(ctx.workspaceDelegationStore), DelegationScopes.ControlPlaneRead);
  if (!access) return json({ error: 'control-plane-read-authority-required', requiredScope: DelegationScopes.ControlPlaneRead }, 403);
  const requested = requestContext(url, matched.ownerNpub, matched.threadId);
  if (!requested) return json({ error: 'live-thread-context-required' }, 400);
  const intercept = resolveIntercept(ctx, requested);
  if (!intercept) return json({ error: 'live-thread-not-found' }, 404);
  const allowedAgentIds = access.delegation?.resourceFilters?.agentIds;
  if (allowedAgentIds?.length && !allowedAgentIds.includes(intercept.agentId)) {
    return json({ error: 'live-thread-not-found' }, 404);
  }
  const turn = ctx.turnStore.getPending(intercept.routingKey);
  const hub = ctx.hub ?? liveThreadActivityHub;
  const latest = hub.latest(requested);

  if (matched.resource === 'snapshot') {
    return json({ version: 1, activity: latest && isCurrent(latest, intercept, turn) ? project(latest, intercept) : null,
      cursor: String(latest?.cursor ?? 0) });
  }

  const cursorText = String(url.searchParams.get('after') ?? '0');
  const cursor = Number(cursorText);
  if (!Number.isSafeInteger(cursor) || cursor < 0) return json({ error: 'invalid-cursor' }, 400);
  const replay = hub.after(requested, cursor);
  if (replay === null) return json({ error: 'cursor-expired', recover: 'snapshot' }, 409);

  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (event: string, value: unknown, id?: number) => controller.enqueue(encoder.encode(
        `${id == null ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
      const current = () => ctx.turnStore.getPending(intercept.routingKey);
      for (const record of replay) if (isCurrent(record, intercept, current())) write('activity', project(record, intercept), record.cursor);
      unsubscribe = hub.subscribe((record) => {
        if (record.workspaceId !== requested.workspaceId || record.channelId !== requested.channelId
          || record.threadId !== requested.threadId || record.agentNpub !== requested.agentNpub) return;
        const refreshed = resolveIntercept(ctx, requested);
        if (!refreshed || refreshed.routingKey !== intercept.routingKey || !isCurrent(record, refreshed, ctx.turnStore.getPending(refreshed.routingKey))) return;
        write('activity', project(record, refreshed), record.cursor);
      });
      timer = setInterval(() => controller.enqueue(encoder.encode(': keepalive\n\n')), ctx.keepaliveMs ?? 20_000);
    },
    cancel() { unsubscribe(); if (timer) clearInterval(timer); },
  });
  request.signal.addEventListener('abort', () => { unsubscribe(); if (timer) clearInterval(timer); }, { once: true });
  return new Response(stream, { headers: { ...headers, 'content-type': 'text/event-stream', connection: 'keep-alive', 'x-accel-buffering': 'no' } });
}
