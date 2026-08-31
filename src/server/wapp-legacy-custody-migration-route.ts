import {
  LegacyWappCustodyMigrationError,
} from "../wapps/legacy-custody-migration-contract";
import type { LegacyWappCustodyMigration } from "../wapps/legacy-custody-migration";

export const WAPP_LEGACY_CUSTODY_MIGRATION_PATH = "/api/admin/wapps/legacy-custody-migration";
const MAX_MIGRATION_REQUEST_BYTES = 64 * 1024;

async function readBoundedJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_MIGRATION_REQUEST_BYTES) {
    throw new LegacyWappCustodyMigrationError("legacy_custody_request_too_large", 413, "Migration request is too large");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_MIGRATION_REQUEST_BYTES) {
    throw new LegacyWappCustodyMigrationError("legacy_custody_request_too_large", 413, "Migration request is too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LegacyWappCustodyMigrationError("legacy_custody_invalid", 400, "Migration request must be valid JSON");
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof LegacyWappCustodyMigrationError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  return Response.json({ error: "legacy_custody_failed", message: "Legacy custody migration failed" }, { status: 500 });
}

export async function handleWappLegacyCustodyMigrationRoute(input: {
  request: Request;
  url: URL;
  method: string;
  isLoopback: boolean;
  isAdmin: boolean;
  migration: LegacyWappCustodyMigration;
}): Promise<Response | null> {
  if (input.url.pathname !== WAPP_LEGACY_CUSTODY_MIGRATION_PATH) return null;
  if (!input.isLoopback) return Response.json({ error: "loopback_required" }, { status: 403 });
  if (!input.isAdmin) return Response.json({ error: "admin_required" }, { status: 403 });
  if (input.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  try {
    const result = await input.migration.migrate(await readBoundedJson(input.request));
    return Response.json({ migration: result });
  } catch (error) {
    return errorResponse(error);
  }
}
