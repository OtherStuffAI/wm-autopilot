import {
  WAPP_TOWER_DB_BROKER_PATH,
  WAPP_TOWER_DB_MAX_BODY_BYTES,
  WappTowerDbBrokerError,
  type WappTowerDbBrokerRequest,
  type WappTowerDbRequestBroker,
} from "../wapps/tower-db-request-broker";

const MAX_BROKER_ENVELOPE_BYTES = WAPP_TOWER_DB_MAX_BODY_BYTES + 16_384;

function errorResponse(error: WappTowerDbBrokerError): Response {
  return Response.json({ error: error.code, message: error.message }, { status: error.status });
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  return match?.[1] ?? null;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BROKER_ENVELOPE_BYTES) {
    throw new WappTowerDbBrokerError("broker_request_too_large", 413, "WApp Tower DB broker request is too large");
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BROKER_ENVELOPE_BYTES) {
        await reader.cancel();
        throw new WappTowerDbBrokerError("broker_request_too_large", 413, "WApp Tower DB broker request is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8"));
  } catch {
    throw new WappTowerDbBrokerError("broker_request_invalid", 400, "WApp Tower DB broker request must be valid JSON");
  }
}

function validateBrokerRequest(input: unknown): WappTowerDbBrokerRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new WappTowerDbBrokerError("broker_request_invalid", 400, "WApp Tower DB broker request must be an object");
  }
  const record = input as Record<string, unknown>;
  const unexpected = Object.keys(record).filter((key) => key !== "method" && key !== "path" && key !== "body");
  if (unexpected.length > 0 || typeof record.method !== "string" || typeof record.path !== "string") {
    throw new WappTowerDbBrokerError("broker_request_invalid", 400, "WApp Tower DB broker accepts only method, path, and optional body");
  }
  return record as unknown as WappTowerDbBrokerRequest;
}

export async function handleWappTowerDbBrokerRoute(input: {
  request: Request;
  url: URL;
  method: string;
  isLoopback: boolean;
  broker: WappTowerDbRequestBroker;
}): Promise<Response | null> {
  if (input.url.pathname !== WAPP_TOWER_DB_BROKER_PATH) return null;
  if (!input.isLoopback) return errorResponse(new WappTowerDbBrokerError("loopback_required", 403, "WApp Tower DB broker accepts loopback callers only"));
  if (input.method !== "POST") return errorResponse(new WappTowerDbBrokerError("broker_method_not_allowed", 405, "WApp Tower DB broker requires POST"));
  const token = bearerToken(input.request);
  if (!token) return errorResponse(new WappTowerDbBrokerError("capability_required", 401, "WApp Tower DB capability is required"));
  try {
    return await input.broker.request(token, validateBrokerRequest(await readBoundedJson(input.request)));
  } catch (error) {
    if (error instanceof WappTowerDbBrokerError) return errorResponse(error);
    return errorResponse(new WappTowerDbBrokerError("broker_request_failed", 500, "WApp Tower DB broker request failed"));
  }
}
