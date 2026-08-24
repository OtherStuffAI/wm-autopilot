import type { RuntimeBotIdentity } from "../agent-chat/types";
import { FlightDeckPgClient } from "../flightdeck-pg/client";
import type { WappRecord } from "./types";
import type { WappSourceAppNpubResolver } from "./wapp-publish-target";

export interface FlightDeckWappRecordPayload {
  app_namespace: string;
  collection_space: "wapp";
  schema_version: 1;
  record_id: string;
  data: {
    title: string;
    description: string | null;
    owner_npub: string;
    wapp_id: string;
    wapp_installation_id: string;
    publisher_npub: string | null;
    registered_open_origins: string[];
    app_id: string;
    launch_url: string;
    source_wingman_url: string | null;
    workspace_owner_npub: string;
    scope_id: string;
    scope_l1_id: string | null;
    scope_l2_id: string | null;
    scope_l3_id: string | null;
    scope_l4_id: string | null;
    scope_l5_id: string | null;
    status: string;
    schedule: {
      timezone?: string | null;
      starts_at?: string | null;
      ends_at?: string | null;
      windows?: Array<{
        days?: number[];
        start_time: string;
        end_time: string;
      }>;
    } | null;
    record_state: string;
  };
  encrypt_to_npubs: string[];
}

export function buildFlightDeckWappRecordPayload(
  wapp: WappRecord,
  appNamespace: string,
): FlightDeckWappRecordPayload {
  return {
    app_namespace: appNamespace,
    collection_space: "wapp",
    schema_version: 1,
    record_id: wapp.id,
    data: {
      title: wapp.title,
      description: wapp.description,
      owner_npub: wapp.ownerNpub,
      wapp_id: wapp.id,
      wapp_installation_id: wapp.wappInstallationId,
      publisher_npub: wapp.publisherNpub,
      registered_open_origins: wapp.registeredOpenOrigins,
      app_id: wapp.appId,
      launch_url: wapp.launchUrl,
      source_wingman_url: wapp.sourceWingmanUrl,
      workspace_owner_npub: wapp.workspaceOwnerNpub,
      scope_id: wapp.scopeId,
      scope_l1_id: wapp.scopeLineage.l1Id,
      scope_l2_id: wapp.scopeLineage.l2Id,
      scope_l3_id: wapp.scopeLineage.l3Id,
      scope_l4_id: wapp.scopeLineage.l4Id,
      scope_l5_id: wapp.scopeLineage.l5Id,
      status: wapp.status,
      schedule: wapp.schedule
        ? {
          timezone: wapp.schedule.timezone ?? null,
          starts_at: wapp.schedule.startsAt ?? null,
          ends_at: wapp.schedule.endsAt ?? null,
          windows: wapp.schedule.windows?.map((window) => ({
            days: window.days,
            start_time: window.startTime,
            end_time: window.endTime,
          })) ?? [],
        }
        : null,
      record_state: wapp.recordState,
    },
    encrypt_to_npubs: wapp.allowedNpubs,
  };
}

export interface WappPublishResult {
  published: boolean;
  reference?: string | null;
  error?: string | null;
  status?: number;
}

export interface WappPublisher {
  publish(payload: FlightDeckWappRecordPayload, wapp: WappRecord): Promise<WappPublishResult>;
}

interface PersonalWappClient {
  listWorkspaces(): Promise<unknown>;
  listPersonalWapps(workspaceId: string, input: {
    ownerNpub?: string | null;
    includeArchived?: boolean;
    limit?: number;
  }): Promise<unknown>;
  createPersonalWapp(workspaceId: string, payload: Record<string, unknown>): Promise<unknown>;
  updatePersonalWapp(workspaceId: string, personalWappId: string, payload: Record<string, unknown>): Promise<unknown>;
  archivePersonalWapp(workspaceId: string, personalWappId: string): Promise<unknown>;
}

interface TowerPgWappPublisherDependencies {
  defaultTowerUrl: string | null;
  authority: RuntimeBotIdentity | null;
  resolveSourceAppNpub: WappSourceAppNpubResolver;
  createClient?: (input: {
    towerUrl: string;
    sourceAppNpub: string;
    authority: RuntimeBotIdentity;
  }) => PersonalWappClient;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function requiredText(value: unknown, error: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(error);
  return text;
}

function workspaceIdForOwner(payload: unknown, workspaceOwnerNpub: string): string {
  const matches = records(record(payload).workspaces).filter((workspace) => (
    record(workspace.identity).workspace_owner_npub === workspaceOwnerNpub
  ));
  if (matches.length === 0) throw new Error("wapp-publish-workspace-not-found");
  if (matches.length > 1) throw new Error("wapp-publish-workspace-ambiguous");
  return requiredText(record(matches[0]!.identity).workspace_id, "wapp-publish-workspace-id-missing");
}

function matchingPersonalWapp(payload: unknown, externalWappId: string): Record<string, unknown> | null {
  const matches = records(record(payload).personal_wapps).filter((wapp) => wapp.wapp_id === externalWappId);
  if (matches.length > 1) throw new Error("wapp-publish-duplicate-personal-wapp");
  return matches[0] ?? null;
}

function towerPayload(payload: FlightDeckWappRecordPayload): Record<string, unknown> {
  return {
    owner_npub: payload.data.workspace_owner_npub,
    scope_id: payload.data.scope_id,
    title: payload.data.title,
    description: payload.data.description,
    launch_url: payload.data.launch_url,
    app_id: payload.data.app_id,
    wapp_id: payload.data.wapp_id,
    wapp_installation_id: payload.data.wapp_installation_id,
    publisher_npub: payload.data.publisher_npub,
    registered_open_origins: payload.data.registered_open_origins,
    source_wingman_url: payload.data.source_wingman_url,
    status: "active",
    metadata: {
      autopilot_wapp: {
        schema_version: payload.schema_version,
        app_namespace: payload.app_namespace,
        owner_npub: payload.data.owner_npub,
        wapp_installation_id: payload.data.wapp_installation_id,
        publisher_npub: payload.data.publisher_npub,
        registered_open_origins: payload.data.registered_open_origins,
        allowed_npubs: payload.encrypt_to_npubs,
        scope_lineage: {
          l1_id: payload.data.scope_l1_id,
          l2_id: payload.data.scope_l2_id,
          l3_id: payload.data.scope_l3_id,
          l4_id: payload.data.scope_l4_id,
          l5_id: payload.data.scope_l5_id,
        },
        schedule: payload.data.schedule,
      },
    },
  };
}

export class TowerPgWappPublisher implements WappPublisher {
  private readonly createClient: NonNullable<TowerPgWappPublisherDependencies["createClient"]>;

  constructor(private readonly deps: TowerPgWappPublisherDependencies) {
    this.createClient = deps.createClient ?? ((input) => new FlightDeckPgClient({
      towerUrl: input.towerUrl,
      wingmanUrl: "",
      appNpub: input.sourceAppNpub,
      botIdentity: input.authority,
    }));
  }

  async publish(payload: FlightDeckWappRecordPayload, wapp: WappRecord): Promise<WappPublishResult> {
    try {
      if (!this.deps.authority) throw new Error("wapp-publish-identity-unavailable");
      const towerUrl = wapp.towerBinding?.towerUrl ?? this.deps.defaultTowerUrl;
      if (!towerUrl) throw new Error("wapp-publish-tower-unavailable");
      const sourceAppNpub = this.deps.resolveSourceAppNpub({
        towerUrl,
        workspaceOwnerNpub: payload.data.workspace_owner_npub,
        managerNpub: wapp.createdByNpub,
      });
      if (!sourceAppNpub) throw new Error("wapp-publish-flightdeck-app-unavailable");

      const client = this.createClient({ towerUrl, sourceAppNpub, authority: this.deps.authority });
      const workspaceId = workspaceIdForOwner(
        await client.listWorkspaces(),
        payload.data.workspace_owner_npub,
      );
      const existing = matchingPersonalWapp(
        await client.listPersonalWapps(workspaceId, {
          ownerNpub: payload.data.workspace_owner_npub,
          includeArchived: true,
          limit: 200,
        }),
        payload.record_id,
      );
      const shouldArchive = payload.data.status === "archived" || payload.data.record_state !== "active";
      if (shouldArchive) {
        if (existing) {
          await client.archivePersonalWapp(
            workspaceId,
            requiredText(existing.id, "wapp-publish-personal-wapp-id-missing"),
          );
        }
        return {
          published: true,
          reference: `flightdeck-pg:${workspaceId}:personal-wapp:${existing?.id ?? payload.record_id}:archived`,
        };
      }

      const body = towerPayload(payload);
      const result = existing
        ? await client.updatePersonalWapp(
          workspaceId,
          requiredText(existing.id, "wapp-publish-personal-wapp-id-missing"),
          body,
        )
        : await client.createPersonalWapp(workspaceId, body);
      const personalWapp = record(record(result).personal_wapp);
      const personalWappId = requiredText(personalWapp.id, "wapp-publish-response-id-missing");
      return {
        published: true,
        reference: `flightdeck-pg:${workspaceId}:personal-wapp:${personalWappId}`,
      };
    } catch (error) {
      return {
        published: false,
        error: (error as Error).message,
        status: 502,
      };
    }
  }
}
