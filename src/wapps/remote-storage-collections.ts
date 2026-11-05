import {
  storageAssert,
  storageHash,
  storageObject,
  storageUuid,
} from "./remote-storage-contract";
import type { RemoteStorageGrant } from "./remote-storage-grants";
export const collectionActions = [
  "collection-begin",
  "collection-page",
  "collection-seal",
  "collection-abort",
  "collection-status",
  "collection-list",
  "deletion-preview",
  "deletion-page",
  "deletion-arm",
  "deletion-cancel",
  "deletion-confirm",
  "deletion-status",
  "deletion-resume",
] as const;
export type CollectionOperation = {
  operation: (typeof collectionActions)[number];
  [key: string]: unknown;
};
const fields: Record<string, string[]> = {
  "collection-begin": ["metadata", "membership_digest"],
  "collection-page": ["set_id", "page", "refs"],
  "collection-seal": ["set_id"],
  "collection-abort": ["set_id"],
  "collection-status": ["set_id", "page"],
  "collection-list": ["page"],
  "deletion-preview": ["set_id"],
  "deletion-page": ["preview_id", "page"],
  "deletion-arm": ["preview_id", "digest"],
  "deletion-cancel": ["preview_id"],
  "deletion-confirm": [
    "preview_id",
    "digest",
    "confirmation_token",
    "set_id",
    "anchor_sha256",
    "membership_digest",
    "total_count",
    "graph_revision",
    "snapshot_expires_at",
    "confirmation_expires_at",
  ],
  "deletion-status": ["preview_id"],
  "deletion-resume": ["preview_id"],
};
export function isCollectionOperation(op: string) {
  return Object.hasOwn(fields, op);
}
function hash(v: unknown) {
  storageAssert(
    typeof v === "string" && storageHash.test(v),
    "storage_request_invalid",
  );
}
function id(v: unknown) {
  storageAssert(
    typeof v === "string" && storageUuid.test(v),
    "storage_request_invalid",
  );
}
export function parseCollectionOperation(value: unknown): CollectionOperation {
  const r = storageObject(value),
    op = String(r.operation);
  storageAssert(
    isCollectionOperation(op),
    "storage_operation_not_allowed",
    403,
  );
  storageObject(r, ["operation", ...fields[op]!]);
  for (const k of fields[op]!)
    storageAssert(Object.hasOwn(r, k), "storage_request_invalid");
  for (const k of ["set_id", "preview_id"]) if (k in r) id(r[k]);
  for (const k of ["digest", "membership_digest", "anchor_sha256"])
    if (k in r) hash(r[k]);
  if ("page" in r)
    storageAssert(
      Number.isInteger(r.page) && Number(r.page) >= 0 && Number(r.page) < 5000,
      "storage_request_invalid",
    );
  if (op === "collection-begin") metadata(r.metadata);
  if (op === "collection-page") refs(r.refs, 50);
  if (op === "deletion-confirm") {
    storageAssert(
      typeof r.confirmation_token === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(r.confirmation_token) &&
        Number.isSafeInteger(r.total_count) &&
        Number(r.total_count) > 0 &&
        Number(r.total_count) <= 100000 &&
        typeof r.graph_revision === "string" &&
        /^\d{1,20}$/.test(r.graph_revision),
      "storage_request_invalid",
    );
    for (const k of ["snapshot_expires_at", "confirmation_expires_at"])
      storageAssert(
        typeof r[k] === "string" && Number.isFinite(Date.parse(r[k] as string)),
        "storage_request_invalid",
      );
  }
  return r as CollectionOperation;
}
export function metadata(value: unknown) {
  const m = storageObject(value, [
    "set_id",
    "source",
    "created",
    "anchor",
    "total_count",
  ]);
  id(m.set_id);
  const s = storageObject(m.source, [
      "origin",
      "identity",
      "scope",
      "workspaceId",
    ]),
    a = storageObject(m.anchor, ["object_id", "sha256"]);
  id(a.object_id);
  hash(a.sha256);
  storageAssert(
    typeof s.origin === "string" &&
      s.origin.length <= 1024 &&
      new URL(s.origin).origin === s.origin &&
      new URL(s.origin).protocol === "https:" &&
      typeof s.identity === "string" &&
      s.identity.length > 0 &&
      s.identity.length <= 256 &&
      (s.scope === "provider"
        ? s.workspaceId === null
        : s.scope === "workspace" &&
          typeof s.workspaceId === "string" &&
          storageUuid.test(s.workspaceId)) &&
      typeof m.created === "string" &&
      new Date(m.created).toISOString() === m.created &&
      Number.isInteger(m.total_count) &&
      Number(m.total_count) > 0 &&
      Number(m.total_count) <= 100000,
    "storage_request_invalid",
  );
  return m;
}
export function refs(value: unknown, max: number, disposition = false) {
  storageAssert(
    Array.isArray(value) && value.length <= max,
    "storage_response_invalid",
  );
  return value.map((v) => {
    const r = storageObject(v, [
      "name",
      "part",
      "object_id",
      "sha256",
      "bytes",
      ...(disposition ? ["disposition"] : []),
    ]);
    id(r.object_id);
    hash(r.sha256);
    storageAssert(
      typeof r.name === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(r.name) &&
        !r.name.includes("..") &&
        Number.isSafeInteger(r.part) &&
        Number(r.part) >= 0 &&
        Number.isSafeInteger(r.bytes) &&
        Number(r.bytes) > 0 &&
        Number(r.bytes) <= 8388608,
      "storage_response_invalid",
    );
    if (disposition)
      storageAssert(
        ["delete_payload", "retained_shared"].includes(String(r.disposition)),
        "storage_response_invalid",
      );
    return r;
  });
}
export function validateCollectionResponse(
  value: unknown,
  g: RemoteStorageGrant,
  op: CollectionOperation,
  now: number,
) {
  const r = storageObject(value);
  // Binding already validated by the broker response entrypoint. Return only known, validated protocol fields.
  const out: Record<string, unknown> = {
    protocol: r.protocol,
    service_npub: r.service_npub,
    workspace_id: r.workspace_id,
    delegation_id: r.delegation_id,
    installation_id: r.installation_id,
  };
  for (const k of ["set_id", "preview_id", "job_id"])
    if (k in r) {
      id(r[k]);
      out[k] = r[k];
    }
  if ("set_id" in op && "set_id" in r)
    storageAssert(op.set_id === r.set_id, "storage_response_invalid");
  if ("preview_id" in op)
    storageAssert(
      (r.preview_id ?? r.job_id) === op.preview_id,
      "storage_response_invalid",
    );
  for (const k of ["digest", "membership_digest"])
    if (k in r) {
      hash(r[k]);
      out[k] = r[k];
    }
  if ("metadata" in r) out.metadata = metadata(r.metadata);
  for (const k of [
    "page",
    "next_page",
    "total_count",
    "anchor_bytes",
    "retained_bytes",
    "delete_bytes",
    "total_objects",
    "physical_absent_objects",
  ])
    if (k in r) {
      storageAssert(
        (k === "next_page" && r[k] === null) ||
          (Number.isSafeInteger(r[k]) && Number(r[k]) >= 0),
        "storage_response_invalid",
      );
      out[k] = r[k];
    }
  for (const k of ["expires_at", "confirmation_expires_at"])
    if (k in r) {
      storageAssert(
        typeof r[k] === "string" && Number.isFinite(Date.parse(r[k] as string)),
        "storage_response_invalid",
      );
      out[k] = r[k];
    }
  for (const k of ["revision", "grant_revision"])
    if (k in r) {
      storageAssert(typeof r[k] === "string", "storage_response_invalid");
      out[k] = r[k];
    }
  if ("destination" in r) {
    const d = storageObject(r.destination, [
      "origin",
      "service_npub",
      "workspace_id",
      "delegation_id",
      "installation_id",
      "app_id",
      "app_npub",
    ]);
    storageAssert(
      d.origin === g.origin &&
        d.service_npub === g.serviceNpub &&
        d.workspace_id === g.workspaceId &&
        d.delegation_id === g.delegationId &&
        d.installation_id === g.installationId &&
        d.app_id === g.appId &&
        d.app_npub === g.appNpub,
      "storage_response_invalid",
    );
    out.destination = d;
  }
  if ("objects" in r) out.objects = refs(r.objects, 25, true);
  if ("refs" in r) out.refs = refs(r.refs, 50);
  if ("state" in r) {
    storageAssert(
      [
        "draft",
        "sealed",
        "aborted",
        "deleted",
        "confirmed",
        "cancelled",
      ].includes(String(r.state)),
      "storage_response_invalid",
    );
    out.state = r.state;
  }
  for (const k of ["logical_deleted", "physical_complete"])
    if (k in r) {
      storageAssert(typeof r[k] === "boolean", "storage_response_invalid");
      out[k] = r[k];
    }
  if ("confirmation_token" in r) {
    storageAssert(
      op.operation === "deletion-arm" &&
        typeof r.confirmation_token === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(r.confirmation_token) &&
        Date.parse(String(r.confirmation_expires_at)) > now &&
        Date.parse(String(r.confirmation_expires_at)) <= now + 125000,
      "storage_response_invalid",
    );
    out.confirmation_token = r.confirmation_token;
  }
  // Raw publisher proof is data only, never used as headers or credentials. App verifies its exact signed body/digest before trusting deletion.
  for (const k of ["confirmation_receipt", "job"])
    if (k in r) {
      storageAssert(
        Buffer.byteLength(JSON.stringify(r[k])) <= 8000,
        "storage_response_invalid",
      );
      out[k] = r[k];
    }
  if ("sets" in r) {
    storageAssert(
      Array.isArray(r.sets) && r.sets.length <= 20,
      "storage_response_invalid",
    );
    out.sets = r.sets.map((v) => {
      const s = storageObject(v, [
        "id",
        "metadata",
        "state",
        "membership_digest",
      ]);
      id(s.id);
      metadata(s.metadata);
      hash(s.membership_digest);
      storageAssert(
        ["draft", "sealed", "deleted", "aborted"].includes(String(s.state)),
        "storage_response_invalid",
      );
      return s;
    });
  }
  return out;
}
