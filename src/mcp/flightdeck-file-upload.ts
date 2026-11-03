import {
  buildFlightDeckPgUrl, fetchPgRequest, parseTowerError, signFlightDeckPgBotRequest, uploadFlightDeckPgStorageObject,
} from "../agent-chat/tower-client";
import type { RuntimeBotIdentity } from "../agent-chat/types";

/**
 * Session file upload through the Autopilot helper: the bot's own key runs the existing storage prepare -> PUT ->
 * complete flow, then links the object as a channel file. Callers bind the channel first (strict-inbox sessions may
 * only upload into a notified channel); Tower re-checks binding and object ownership for classified bots.
 */
export const SESSION_FILE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface SessionFileUploadInput {
  fileName: unknown;
  contentType: unknown;
  base64Data: unknown;
}

export function parseSessionFileUpload(input: SessionFileUploadInput, maxBytes = SESSION_FILE_UPLOAD_MAX_BYTES):
  { fileName: string; contentType: string; content: Uint8Array } | { error: string; status: number } {
  const fileName = typeof input.fileName === "string" ? input.fileName.trim() : "";
  if (!fileName || fileName.length > 255 || /[/\\\u0000]/.test(fileName) || fileName === "." || fileName === "..") {
    return { error: "fileName must be a plain file name (no path separators), 1-255 characters", status: 400 };
  }
  const contentType = typeof input.contentType === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(input.contentType.trim())
    ? input.contentType.trim() : "application/octet-stream";
  const data = typeof input.base64Data === "string" ? input.base64Data.replace(/\s+/g, "") : "";
  if (!data || data.length % 4 !== 0 || !BASE64.test(data)) return { error: "base64_data must be valid padded base64", status: 400 };
  if (Math.floor(data.length / 4) * 3 > maxBytes + 2) return { error: `File exceeds the ${maxBytes} byte session upload limit`, status: 413 };
  const content = new Uint8Array(Buffer.from(data, "base64"));
  if (content.byteLength === 0) return { error: "File is empty", status: 400 };
  if (content.byteLength > maxBytes) return { error: `File exceeds the ${maxBytes} byte session upload limit`, status: 413 };
  return { fileName, contentType, content };
}

export async function createFlightDeckPgChannelFile(params: {
  backendConnectionId?: string | null;
  subscriptionId?: string | null;
  backendBaseUrl: string;
  workspaceId: string;
  channelId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  storageObjectId: string;
  displayName: string;
  /** Strict inbox: the live origin notification; Tower mints a version-bound work receipt for the linked file. */
  originNotificationId?: string | null;
}): Promise<Record<string, unknown>> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/channels/${encodeURIComponent(params.channelId)}/files`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = { storage_object_id: params.storageObjectId, display_name: params.displayName,
    ...(params.originNotificationId ? { origin_notification_id: params.originNotificationId } : {}) };
  const authorization = await signFlightDeckPgBotRequest({ backendConnectionId: params.backendConnectionId, subscriptionId: params.subscriptionId,
    botIdentity: params.botIdentity, url, method: "POST", body });
  const response = await fetchPgRequest(params, url, {
    method: "POST",
    headers: { Accept: "application/json", Authorization: authorization, "Content-Type": "application/json", "x-flightdeck-pg-app-npub": params.appNpub },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await parseTowerError(response, "flightdeck_pg_channel_file_create");
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as Record<string, unknown>;
}

export async function uploadSessionFileToChannel(params: {
  backendConnectionId?: string | null;
  subscriptionId?: string | null;
  backendBaseUrl: string;
  workspaceId: string;
  channelId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  fileName: string;
  contentType: string;
  content: Uint8Array;
  originNotificationId?: string | null;
}) {
  const uploaded = await uploadFlightDeckPgStorageObject({ ...params });
  const file = await createFlightDeckPgChannelFile({ ...params, storageObjectId: uploaded.object_id, displayName: params.fileName });
  return { storage_object_id: uploaded.object_id, size_bytes: params.content.byteLength, file,
    ...(file.work_receipt ? { work_receipt: file.work_receipt } : {}) };
}
