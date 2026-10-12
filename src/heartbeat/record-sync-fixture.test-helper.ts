import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runHeartbeatWake,
  type HeartbeatWakeOptions,
} from "./heartbeat-wake.ts";
import {
  type Change,
  type JsonRecord,
  MAX_BYTES,
  MAX_ENTRIES,
} from "./record-sync-protocol.ts";

export const families = [
  "scope_order",
  "scope",
  "channel",
  "thread",
  "message",
  "task",
  "task_comment",
  "task_assignment",
  "doc",
  "doc_comment",
  "file",
  "file_folder",
  "audio_note",
  "daily_note",
  "personal_wapp",
  "resource_view_state",
  "autopilot_connection",
  "workspace_agent",
  "feed_subscription",
  "feed_item_state",
  "context_component",
  "context_reference",
];
export function change(
  id: string,
  family = "task",
  version = "9007199254740993",
  extra: JsonRecord = {},
): Change {
  return {
    family,
    id,
    version,
    operation: "upsert",
    workspace_id: "workspace",
    scope_id: "scope",
    channel_id: "channel",
    row: {
      id,
      workspace_id: "workspace",
      title: id,
      updated_at: "2020-01-01T00:00:00Z",
      ...extra,
    },
  };
}
export function pagePayload(
  changes: Change[] = [],
  terminal = false,
  extra: JsonRecord = {},
): JsonRecord {
  return {
    protocol_version: 2,
    client_id: "",
    checkpoint_revision: "0",
    families,
    mode: terminal ? "delta" : "snapshot",
    changes,
    actors: [],
    access_changes: [],
    access_revision: "1",
    retention_policy: "retain_downloaded",
    catchup: null,
    next_cursor: "",
    has_more: !terminal,
    snapshot_id: terminal ? null : "snapshot",
    snapshot_complete: !terminal,
    partitions_complete: terminal ? [] : families,
    bounds: { max_bytes: MAX_BYTES, max_rows: MAX_ENTRIES },
    handover: {
      target_position: extra.snapshot_complete === false && !terminal ? null : "9007199254740993",
      through_position: terminal ? "9007199254740993" : "0",
      complete: terminal,
      authority_epoch: "epoch",
      access_revision: "1",
    },
    ...extra,
  };
}
export function fixture(
  pages: JsonRecord[],
  options: Partial<HeartbeatWakeOptions> = {},
) {
  const cacheRoot = mkdtempSync(join(tmpdir(), "heartbeat-v2-"));
  const calls: { url: URL; method: string; body: string }[] = [];
  const signs: JsonRecord[] = [];
  let index = 0;
  let ackError: string | null = null;
  let pageError: string | null = null;
  let ackFailures = 0;
  let registeredId = "";
  let checkpoint: string | null = null;
  let revision = 0;
  let extension = true;
  let bound = false;
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    if (url.pathname.includes("/identity"))
      return Response.json({ identityType: "agent", botNpub: "viewer" });
    if (url.pathname.includes("/nip98")) {
      signs.push(JSON.parse(body));
      return Response.json({ token: "Nostr fixture" });
    }
    if (url.pathname === "/api/mcp/wingman/flightdeck") {
      const command = JSON.parse(body);
      if (command.action === "context")
        return Response.json({
          workspace: bound
            ? {
                workspaceId: "workspace",
                backendBaseUrl: "https://tower.test",
                sourceAppNpub: "app",
              }
            : null,
        });
      if (command.action === "transport_prepare")
        return Response.json({
          url: command.url.replace(
            "https://tower.test",
            "http://node.fips:43100",
          ),
        });
      if (command.action === "record_sync_request")
        return fetchImpl(command.url, {
          method: command.method,
          headers: command.headers,
          ...(command.bodyBase64 === null
            ? {}
            : { body: Buffer.from(command.bodyBase64, "base64").toString() }),
          signal: init?.signal,
        });
      throw new Error("Unknown fixture broker operation");
    }
    calls.push({ url, method, body });
    if (url.pathname.endsWith("/service"))
      return Response.json({
        record_sync: {
          protocol_versions: [1, 2],
          device_checkpoints: true,
          additive_access: true,
          retention_policy: "retain_downloaded",
          extensions: extension ? ["bounded_snapshot_v1"] : [],
        },
      });
    const id = url.pathname.split("/clients/")[1]?.split("/")[0];
    const registration = () => ({
      protocol_version: 2,
      client_id: id,
      authority_epoch: "epoch",
      initial_cursor: "bootstrap",
      checkpoint_cursor: checkpoint,
      checkpoint_revision: String(revision),
    });
    if (url.pathname.endsWith("/ack")) {
      if (ackFailures > 0) {
        ackFailures--;
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      if (ackError) return Response.json({ error: ackError }, { status: 409 });
      const intent = JSON.parse(body);
      if (checkpoint !== intent.cursor) {
        revision++;
        checkpoint = intent.cursor;
      }
      return Response.json(registration());
    }
    if (id) {
      if (method === "POST" && id !== registeredId) {
        registeredId = id!;
        checkpoint = null;
        revision = 0;
      }
      return Response.json(registration());
    }
    if (pageError) return Response.json({ error: pageError }, { status: 409 });
    const p = pages[index++] ?? pagePayload([], true);
    return Response.json({
      ...p,
      client_id: registeredId,
      checkpoint_revision: String(revision),
      next_cursor: `opaque-${index}`,
    });
  }) as typeof fetch;
  const context = {
    wingmanUrl: "https://broker.test",
    sessionId: crypto.randomUUID(),
    capabilityToken: "fixture",
    fetch: fetchImpl,
  };
  return {
    cacheRoot,
    calls,
    signs,
    context,
    setAckError(value: string | null) {
      ackError = value;
    },
    setPageError(value: string | null) {
      pageError = value;
    },
    setAckFailures(n: number) {
      ackFailures = n;
    },
    setExtension(value: boolean) {
      extension = value;
    },
    setBound(value: boolean) {
      bound = value;
    },
    run(overrides: Partial<HeartbeatWakeOptions> = {}) {
      return runHeartbeatWake({
        hours: 12,
        workspaceId: "workspace",
        towerUrl: "https://tower.test",
        appNpub: "app",
        context,
        cacheRoot,
        ...options,
        ...overrides,
      });
    },
  };
}
