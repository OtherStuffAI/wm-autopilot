import {
  artifactContextUrl, contextCreateSchema, contextDeleteSchema, contextId, contextLinkSchema,
  contextPageSizeSchema, contextVersionSchema, contextRouteSchema, contextUpdateSchema,
  type ContextComponent, type ContextCreate, type ContextDelete, type ContextEnvelope, type ContextLink,
  type ContextMutation, type ContextPreview, type ContextReference, type ContextUpdate,
} from "./context-contract.ts";
import { FlightDeckPgResponseError } from "./response-error.ts";

type Json = Record<string, unknown>;
type RequestJson = (method: string, path: string, query?: Record<string, string | number | null | undefined>, body?: unknown) => Promise<Json>;
export class ContextTreeClient {
  constructor(private readonly request: RequestJson, private readonly sources: {
    doc: (workspace: string, id: string) => Promise<unknown>;
    file: (workspace: string, id: string) => Promise<unknown>;
    task: (workspace: string, id: string) => Promise<unknown>;
  }) {}

  private path(workspace: string, scope: string, component?: string): string {
    contextRouteSchema.parse({ workspace_id: workspace, scope_id: scope });
    const prefix = `/api/v4/flightdeck-pg/workspaces/${workspace}/scopes/${scope}/context/components`;
    return component === undefined ? prefix : `${prefix}/${contextId(component)}`;
  }

  private async pages<T>(path: string, key: string, limit = 200): Promise<ContextEnvelope & { rows: T[]; complete: true; pages_read: number }> {
    contextPageSizeSchema.parse(limit);
    let cursor: string | null = null;
    let envelope: Json = {};
    const rows: T[] = [];
    const seen = new Set<string>();
    let pages = 0;
    do {
      envelope = await this.request("GET", path, { limit, cursor });
      if (!Array.isArray(envelope[key]) || !(envelope.next_cursor === null || typeof envelope.next_cursor === "string")) {
        throw new Error("Invalid context pagination envelope");
      }
      rows.push(...envelope[key] as T[]);
      pages++;
      cursor = envelope.next_cursor as string | null;
      if (cursor !== null) {
        if (!cursor || seen.has(cursor)) throw new Error("Context pagination cursor did not advance");
        seen.add(cursor);
      }
    } while (cursor !== null);
    return { ...envelope, rows, complete: true, pages_read: pages } as ContextEnvelope & { rows: T[]; complete: true; pages_read: number };
  }

  async list(workspace: string, scope: string, limit?: number) {
    const { rows, ...envelope } = await this.pages<ContextComponent>(this.path(workspace, scope), "components", limit);
    return { ...envelope, components: rows, next_cursor: null };
  }
  async references(workspace: string, scope: string, component: string, limit?: number) {
    const { rows, ...envelope } = await this.pages<ContextReference>(`${this.path(workspace, scope, component)}/references`, "references", limit);
    return { ...envelope, references: rows, next_cursor: null };
  }
  async read(workspace: string, scope: string, component: string) {
    contextId(component);
    const { components, ...envelope } = await this.list(workspace, scope);
    const selected = components.find(row => row.id === component);
    if (!selected) throw new FlightDeckPgResponseError(404, { error: "Context unavailable", code: "context_not_found", identity: envelope.identity }, "context read");
    return { ...envelope, component: selected };
  }
  async pathTo(workspace: string, scope: string, component: string) {
    contextId(component);
    const { components, ...envelope } = await this.list(workspace, scope);
    const byId = new Map(components.map(row => [row.id, row]));
    const selected = byId.get(component);
    if (!selected) throw new FlightDeckPgResponseError(404, { error: "Context unavailable", code: "context_not_found", identity: envelope.identity }, "context path");
    const path: ContextComponent[] = [];
    const seen = new Set<string>();
    let row: ContextComponent | undefined = selected;
    while (row) {
      if (seen.has(row.id)) throw new Error("Context hierarchy contains a cycle");
      seen.add(row.id);
      path.unshift(row);
      if (row.parent_id === null) break;
      row = byId.get(row.parent_id);
      if (!row) throw new Error("Context ancestor is missing; reload the scope before continuing");
    }
    return { ...envelope, path, siblings: components.filter(row => row.parent_id === selected.parent_id && row.id !== selected.id), children: components.filter(row => row.parent_id === selected.id) };
  }
  async reference(workspace: string, scope: string, component: string, referenceId: string) {
    contextId(referenceId);
    const result = await this.references(workspace, scope, component);
    const reference = result.references.find(row => row.id === referenceId);
    if (!reference || reference.resolution.status === "unavailable") return { identity: result.identity, status: "unavailable" };
    if (reference.target_type === "artifact") return {
      identity: result.identity, status: "external", descriptor: reference.target,
      url: artifactContextUrl(reference.target), version_policy: "latest", access_checked: false,
    };
    try {
      const source = await this.sources[reference.target_type](workspace, contextId(reference.target.record_id));
      return { identity: result.identity, status: "available", source };
    } catch (error) {
      if ((error instanceof FlightDeckPgResponseError || (error instanceof Error && "status" in error)) && [403, 404].includes(Number(error.status))) return { identity: result.identity, status: "unavailable" };
      throw error;
    }
  }
  async create(workspace: string, scope: string, input: ContextCreate) {
    return await this.request("POST", this.path(workspace, scope), undefined, contextCreateSchema.parse(input)) as unknown as ContextMutation & { component: ContextComponent };
  }
  async update(workspace: string, scope: string, component: string, input: ContextUpdate) {
    return await this.request("PATCH", this.path(workspace, scope, component), undefined, contextUpdateSchema.parse(input)) as unknown as ContextMutation & { component: ContextComponent };
  }
  async link(workspace: string, scope: string, component: string, input: ContextLink) {
    return await this.request("POST", `${this.path(workspace, scope, component)}/references`, undefined, contextLinkSchema.parse(input)) as unknown as ContextMutation & { reference: ContextReference };
  }
  async unlink(workspace: string, scope: string, component: string, reference: string, expectedRowVersion: number) {
    const expected_row_version = contextVersionSchema.parse(expectedRowVersion);
    return await this.request("DELETE", `${this.path(workspace, scope, component)}/references/${contextId(reference)}`, undefined, { expected_row_version }) as unknown as ContextMutation & { reference: ContextReference };
  }
  async deletePreview(workspace: string, scope: string, component: string) {
    return await this.request("GET", `${this.path(workspace, scope, component)}/delete-preview`) as unknown as ContextEnvelope & { preview: ContextPreview };
  }
  async confirmedDelete(workspace: string, scope: string, component: string, input: ContextDelete) {
    const { confirmation_token } = contextDeleteSchema.parse(input);
    return await this.request("POST", `${this.path(workspace, scope, component)}/delete`, undefined, { confirmation_token }) as unknown as ContextMutation & { deleted: { component_id: string; component_count: number; reference_count: number } };
  }
}
