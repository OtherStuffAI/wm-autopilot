import { inboxOriginCandidates, liveInboxOrigin, type InboxOriginOwner } from '../agent-chat/agent-inbox-origins';
import { agentInboxReceiptStore, parseWorkReceipt, type AgentInboxReceiptStore, type WorkReceipt, type WorkReceiptEntityType } from '../agent-chat/agent-inbox-receipts';
import type { AgentInboxScope } from '../agent-chat/agent-inbox-scope';
import {
  buildFlightDeckPgUrl, decodeFlightDeckPgDocumentBody, fetchFlightDeckPgDocument, fetchFlightDeckPgTask, fetchPgRequest, parseTowerError,
  signFlightDeckPgBotRequest, type FlightDeckPgDocumentResult,
} from '../agent-chat/tower-client';
import { capturedDocumentBase } from '../flightdeck-pg/document-update-base';
import {
  INBOX_BOUND_WRITE_ACTIONS, INBOX_READ_ACTIONS, INBOX_REFUSED_ACTIONS, INBOX_SCOPED_WRITE_ACTIONS, answerInboxAttachment, answerInboxRead,
  inboxLocation, resolveInboxReadOrigin, resolveInboxSessionScope, resolveInboxWriteOrigin, type BoundOrigin, type InboxSessionTarget,
} from './agent-inbox-session-helper';

/**
 * Strict-inbox Flight Deck helper routing. Every call acts for the exact origin notification of the session (or its
 * run/worker snapshot). When that origin does not bind the requested task/document/file, the bot may still follow up on
 * its OWN output through a Tower-minted work receipt: only an entity Tower receipted for an origin this session acted
 * for, only while that origin is live, and only at the receipted version (otherwise `agent_inbox_work_output_changed`
 * with no content). Receipts never unlock comment reads, attachments, history or anything the bot did not create.
 */
export interface InboxHelperCall {
  action: string;
  body: Record<string, unknown>;
  owner: InboxOriginOwner;
  ids: { channelId: string | null; threadId: string | null; taskId: string | null; documentId: string | null };
  target: InboxSessionTarget;
  /** The ordinary helper action (Tower re-checks binding/receipts for classified bots). */
  runAction: (origin?: BoundOrigin) => Promise<Response>;
  /** The ordinary helper action with its pre-reads answered from the bound notification context. */
  runScoped: (scope: AgentInboxScope, origin: BoundOrigin) => Promise<Response>;
}

export interface InboxHelperRouteDeps {
  receipts?: Pick<AgentInboxReceiptStore, 'get' | 'recordCreated' | 'followUpdate'>;
  fetchDocument?: typeof fetchFlightDeckPgDocument;
  fetchTask?: typeof fetchFlightDeckPgTask;
  fetchFile?: typeof fetchReceiptedFile;
}

/** Creates that Tower receipts, and which response field carries the created entity. */
const CREATE_RECEIPTS: Record<string, { entityType: WorkReceiptEntityType; entityId: (json: any) => unknown }> = {
  doc_create: { entityType: 'doc', entityId: (json) => json?.result?.doc?.id },
  task_create: { entityType: 'task', entityId: (json) => json?.result?.task?.id },
  file_upload: { entityType: 'file', entityId: (json) => json?.file?.file?.id },
};
/** Follow-ups a receipt may serve when the origin does not bind the entity. */
const RECEIPT_ACTIONS: Record<string, WorkReceiptEntityType> = {
  doc_get: 'doc', doc_update: 'doc', task_get: 'task', task_state: 'task', task_comment: 'task', file_get: 'file',
};
const RECEIPT_UPDATES = new Set(['doc_update', 'task_state']);

const refuse = (code: string, message: string, status = 403) => Response.json({ error: message, code }, { status });
const changed = () => Response.json({ error: 'The receipted work output changed since this agent last wrote it; its content is not available.',
  code: 'agent_inbox_work_output_changed', retryable: false }, { status: 409 });
const isTowerWorkOutputChanged = (error: unknown) => {
  const e = error as { status?: unknown; code?: unknown; detailCode?: unknown; message?: unknown };
  return Number(e?.status) === 409 && [e?.code, e?.detailCode, e?.message].some((value) => String(value ?? '').includes('work_output_changed'));
};

export async function routeInboxHelperCall(call: InboxHelperCall, deps: InboxHelperRouteDeps = {}): Promise<Response> {
  const { action } = call;
  if (action.startsWith('context_tree_') || INBOX_REFUSED_ACTIONS.has(action)) {
    return refuse('agent_inbox_unbound_action', `${action} is not available to a strict-inbox agent session.`);
  }
  if (action === 'file_get') return viaReceipt(call, deps, 'file', text(call.body.fileId) ?? text(call.body.file_id),
    refuse('agent_inbox_no_bound_notification', 'Only files this agent created for a live notification can be read.'));
  if (INBOX_BOUND_WRITE_ACTIONS.has(action)) {
    const origin = resolveInboxWriteOrigin(call.owner, action, call.ids);
    if (origin instanceof Response) {
      return action === 'task_comment' ? viaReceipt(call, deps, 'task', call.ids.taskId, origin) : origin;
    }
    const response = await call.runAction(origin);
    const create = CREATE_RECEIPTS[action];
    return create ? recordCreateReceipt(response, call, deps, origin, create) : response;
  }
  if (INBOX_READ_ACTIONS.has(action) || INBOX_SCOPED_WRITE_ACTIONS.has(action)) {
    const origin = INBOX_SCOPED_WRITE_ACTIONS.has(action)
      ? resolveInboxWriteOrigin(call.owner, action, call.ids)
      : resolveInboxReadOrigin(call.owner, inboxLocation(action, call.ids));
    if (origin instanceof Response) {
      const entityType = RECEIPT_ACTIONS[action];
      return entityType ? viaReceipt(call, deps, entityType, entityType === 'doc' ? call.ids.documentId : call.ids.taskId, origin) : origin;
    }
    const scope = await resolveInboxSessionScope(call.target, origin);
    if (scope instanceof Response) return scope;
    if (action === 'attachment_get') return answerInboxAttachment(call.target, scope, text(call.body.storageObjectId) ?? text(call.body.storage_object_id));
    if (INBOX_READ_ACTIONS.has(action)) return answerInboxRead(action, scope);
    return call.runScoped(scope, origin);
  }
  return call.runAction();
}

/** Keeps the receipt Tower minted for exactly the created entity and the origin sent; the response is returned unchanged. */
async function recordCreateReceipt(response: Response, call: InboxHelperCall, deps: InboxHelperRouteDeps, origin: BoundOrigin,
  create: { entityType: WorkReceiptEntityType; entityId: (json: any) => unknown }): Promise<Response> {
  if (!response.ok) return response;
  const json = await response.clone().json().catch(() => null) as Record<string, any> | null;
  const receipt = parseWorkReceipt(json?.work_receipt, { entityType: create.entityType, entityId: text(create.entityId(json)), originNotificationId: origin.towerOriginId });
  if (receipt) (deps.receipts ?? agentInboxReceiptStore()).recordCreated(call.target.subscriptionId, receipt);
  return response;
}

/** The receipt may serve this session only if its origin is one the session acted for and is still live. */
function ownedLiveReceipt(call: InboxHelperCall, receipt: WorkReceipt): Response | null {
  const owned = new Set<string>();
  for (const candidate of inboxOriginCandidates(call.owner)) {
    const live = liveInboxOrigin(candidate);
    if (live.ok) owned.add(live.towerOriginId);
  }
  if (!owned.has(receipt.originNotificationId)) {
    return refuse('agent_inbox_receipt_not_owned', 'This work output was created for a notification this session did not act for, or that is no longer live.');
  }
  const live = liveInboxOrigin({ subscriptionId: call.target.subscriptionId, notificationId: receipt.originNotificationId });
  return live.ok ? null : refuse(live.code, 'The notification this work output was created for is no longer live.');
}

async function viaReceipt(call: InboxHelperCall, deps: InboxHelperRouteDeps, entityType: WorkReceiptEntityType, entityId: string | null,
  refusal: Response): Promise<Response> {
  const store = deps.receipts ?? agentInboxReceiptStore();
  const receipt = entityId ? store.get(call.target.subscriptionId, entityType, entityId) : null;
  if (!receipt) return refusal;
  const denied = ownedLiveReceipt(call, receipt);
  if (denied) return denied;
  const pg = { ...call.target };
  try {
    if (entityType === 'doc') {
      // The body is read for the content guard; it is returned only for doc_get and only at the receipted version.
      const doc = await (deps.fetchDocument ?? fetchFlightDeckPgDocument)({ ...pg, documentId: receipt.entityId, includeBody: true });
      if (!documentMatches(doc, receipt)) return changed();
      if (call.action === 'doc_get') {
        return Response.json({ ok: true, ...doc, body_text: decodeFlightDeckPgDocumentBody(doc), captured_base: safeDocumentBase(doc),
          receipted: true, receipt_origin_notification_id: receipt.originNotificationId });
      }
    } else if (entityType === 'task') {
      const result = await (deps.fetchTask ?? fetchFlightDeckPgTask)({ ...pg, taskId: receipt.entityId });
      if (Number(result.task?.row_version) !== receipt.rowVersion) return changed();
      if (call.action === 'task_get') return Response.json({ ok: true, task: result.task, receipted: true, receipt_origin_notification_id: receipt.originNotificationId });
    } else {
      const file = await (deps.fetchFile ?? fetchReceiptedFile)({ ...pg, fileId: receipt.entityId });
      if (Number(file?.row_version) !== receipt.rowVersion || (receipt.versionId && file?.current_version_id !== receipt.versionId)) return changed();
      return Response.json({ ok: true, file, receipted: true, receipt_origin_notification_id: receipt.originNotificationId });
    }
  } catch (error) {
    if (isTowerWorkOutputChanged(error)) return changed();
    throw error;
  }
  const response = await call.runAction();
  if (!RECEIPT_UPDATES.has(call.action) || !response.ok) return response;
  const json = await response.clone().json().catch(() => null) as Record<string, any> | null;
  const next = parseWorkReceipt(json?.result?.work_receipt, { entityType, entityId: receipt.entityId, originNotificationId: receipt.originNotificationId });
  // Followed only when it names the version this very update produced; otherwise later follow-ups fail closed.
  const updatedVersion = Number((entityType === 'doc' ? json?.result?.doc : json?.result?.task)?.row_version);
  store.followUpdate(call.target.subscriptionId, receipt, next && next.rowVersion > receipt.rowVersion && next.rowVersion === updatedVersion ? next : null);
  return response;
}

function documentMatches(doc: FlightDeckPgDocumentResult, receipt: WorkReceipt): boolean {
  if (Number((doc.doc as { row_version?: unknown } | undefined)?.row_version) !== receipt.rowVersion) return false;
  return !receipt.bodySha256Hex || safeDocumentBase(doc)?.base_body_sha256_hex === receipt.bodySha256Hex;
}

/** The canonical base, or null when Tower's canonical version is missing or inconsistent (treated as changed). */
function safeDocumentBase(doc: FlightDeckPgDocumentResult) {
  try {
    return doc.canonical_version ? capturedDocumentBase(doc) : null;
  } catch {
    return null;
  }
}

/** GET /files/{id}: metadata only (no bytes), signed by the bot. */
export async function fetchReceiptedFile(params: InboxSessionTarget & { fileId: string }): Promise<Record<string, any> | null> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/files/${encodeURIComponent(params.fileId)}`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const authorization = await signFlightDeckPgBotRequest({ backendConnectionId: params.backendConnectionId, subscriptionId: params.subscriptionId,
    botIdentity: params.botIdentity, url, method: 'GET' });
  const response = await fetchPgRequest(params, url, { headers: { Accept: 'application/json', Authorization: authorization, 'x-flightdeck-pg-app-npub': params.appNpub } });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_file');
    throw Object.assign(new Error(error.message), error);
  }
  return ((await response.json()) as { file?: Record<string, any> }).file ?? null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
