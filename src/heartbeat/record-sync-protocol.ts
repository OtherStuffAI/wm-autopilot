export const MAX_BYTES = 1_048_576;
export const MAX_ENTRIES = 200;
export const PAGE_MS = 30_000;
export type JsonRecord = Record<string, unknown>;
export function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}
export function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.length > 4096)
    throw new Error(`Invalid ${name}`);
  return value;
}
export function decimal(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^(0|[1-9][0-9]*)$/.test(result)) throw new Error(`Invalid ${name}`);
  return result;
}
export function list(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 200 ||
    value.some((item) => typeof item !== "string" || !item)
  )
    throw new Error(`Invalid ${name}`);
  if (new Set(value).size !== value.length)
    throw new Error(`Duplicate ${name}`);
  return value as string[];
}
export interface Change {
  family: string;
  id: string;
  version: string;
  operation: "upsert" | "delete";
  workspace_id: string;
  scope_id: string | null;
  channel_id: string | null;
  row: JsonRecord | null;
}
export interface Access extends JsonRecord {
  family: string;
  resource_type: "workspace" | "scope" | "channel";
  resource_id: string;
  resource_kind?: string;
  status: "granted" | "lost";
}
export interface Page extends JsonRecord {
  protocol_version: 2;
  client_id: string;
  checkpoint_revision: string;
  families: string[];
  mode: "snapshot" | "delta";
  changes: Change[];
  actors: JsonRecord[];
  access_changes: Access[];
  access_revision: string;
  next_cursor: string;
  snapshot_id: string | null;
  snapshot_complete: boolean;
  has_more: boolean;
  partitions_complete: string[];
}
export interface Registration extends JsonRecord {
  protocol_version: 2;
  client_id: string;
  authority_epoch: string;
  initial_cursor: string;
  checkpoint_cursor: string | null;
  checkpoint_revision: string;
}
export function registration(value: unknown, clientId: string): Registration {
  const r = record(value);
  if (r.protocol_version !== 2 || r.client_id !== clientId)
    throw new Error("Registration identity mismatch");
  text(r.authority_epoch, "authority epoch");
  text(r.initial_cursor, "initial cursor");
  if (r.checkpoint_cursor !== null)
    text(r.checkpoint_cursor, "checkpoint cursor");
  decimal(r.checkpoint_revision, "checkpoint revision");
  return r as Registration;
}
export function page(
  value: unknown,
  clientId: string,
  workspaceId: string,
): Page {
  const p = record(value);
  if (p.protocol_version !== 2 || p.client_id !== clientId)
    throw new Error("Page cache/protocol mismatch");
  decimal(p.checkpoint_revision, "checkpoint revision");
  text(p.next_cursor, "next cursor");
  const families = list(p.families, "families");
  if (!families.length) throw new Error("Missing advertised families");
  const partitions = list(p.partitions_complete, "partitions complete");
  if (partitions.some((family) => !families.includes(family)))
    throw new Error("Unknown completed family");
  if (
    !["snapshot", "delta"].includes(String(p.mode)) ||
    typeof p.has_more !== "boolean" ||
    typeof p.snapshot_complete !== "boolean"
  )
    throw new Error("Invalid page completion metadata");
  if (p.mode === "snapshot") {
    text(p.snapshot_id, "snapshot id");
    if (
      !p.has_more ||
      (p.snapshot_complete &&
        families.some((family) => !partitions.includes(family)))
    )
      throw new Error(
        "Snapshot must hand over to delta with complete families",
      );
  } else if (p.snapshot_id !== null || p.snapshot_complete)
    throw new Error("Invalid delta metadata");
  if (
    p.large_records !== undefined &&
    (!Array.isArray(p.large_records) || p.large_records.length)
  )
    throw new Error("Unnegotiated oversized record manifest; no advancement");
  const bounds = record(p.bounds);
  if (bounds.max_bytes !== MAX_BYTES || bounds.max_rows !== MAX_ENTRIES)
    throw new Error("Unexpected record-sync bounds");
  if (
    !Array.isArray(p.changes) ||
    !Array.isArray(p.actors) ||
    !Array.isArray(p.access_changes)
  )
    throw new Error("Missing canonical/access metadata");
  if (
    p.changes.length + p.actors.length + p.access_changes.length >
    MAX_ENTRIES
  )
    throw new Error("Record-sync entry ceiling exceeded");
  decimal(p.access_revision, "access revision");
  if (p.retention_policy !== "retain_downloaded")
    throw new Error("Unsupported retention policy");
  for (const input of p.changes) {
    const c = record(input);
    text(c.id, "record id");
    decimal(c.version, "record version");
    if (!families.includes(String(c.family)) || c.workspace_id !== workspaceId)
      throw new Error("Record workspace/family mismatch");
    for (const key of ["channel_id", "scope_id"])
      if (c[key] !== null) text(c[key], key);
    if (
      c.operation === "delete"
        ? c.row !== null
        : c.operation !== "upsert" || !Object.keys(record(c.row)).length
    )
      throw new Error("Invalid canonical change");
    const row = record(c.row);
    if (c.operation === "upsert" && row.workspace_id !== workspaceId)
      throw new Error("Canonical row workspace mismatch");
  }
  for (const input of p.actors) {
    const a = record(input);
    text(a.actor_id, "actor id");
    text(a.npub, "actor npub");
    if (
      !["human", "agent", "app", "service"].includes(String(a.kind)) ||
      (a.display_name !== null && typeof a.display_name !== "string")
    )
      throw new Error("Invalid actor sidecar");
  }
  for (const input of p.access_changes) {
    const a = record(input);
    text(a.resource_id, "access resource");
    if (
      !families.includes(String(a.family)) ||
      !["workspace", "scope", "channel"].includes(String(a.resource_type)) ||
      !["granted", "lost"].includes(String(a.status))
    )
      throw new Error("Invalid access notification");
  }
  return p as unknown as Page;
}

export interface Handover {
  target_position: string | null;
  through_position: string;
  complete: boolean;
  authority_epoch: string;
  access_revision: string;
}
export function handover(p: Page): Handover {
  const h = record(p.handover);
  if (h.target_position !== null) decimal(h.target_position, "handover target");
  decimal(h.through_position, "handover through position");
  text(h.authority_epoch, "handover authority epoch");
  decimal(h.access_revision, "handover access revision");
  if (
    h.access_revision !== p.access_revision ||
    typeof h.complete !== "boolean"
  )
    throw new Error("Invalid handover authority metadata");
  if (
    h.complete &&
    (h.target_position === null ||
      BigInt(String(h.through_position)) !== BigInt(String(h.target_position)) ||
      p.has_more ||
      p.mode !== "delta" ||
      p.catchup !== null)
  )
    throw new Error("Incomplete handover certificate");
  if (p.mode === "snapshot" && !p.snapshot_complete && h.target_position !== null) throw new Error("Snapshot target pinned before traversal completed");
  if (p.mode === "delta" && h.target_position === null) throw new Error("Missing fixed delta target");
  if (!p.has_more && !h.complete)
    throw new Error("Terminal page lacks handover certificate");
  return h as unknown as Handover;
}
