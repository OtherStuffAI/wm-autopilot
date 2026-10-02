import { z } from "zod";
import { contextCreateSchema, contextDeleteSchema, contextLinkSchema, contextPageSizeSchema, contextRouteSchema, contextUpdateSchema, contextVersionSchema } from "./context-contract.ts";
import type { ContextTreeClient } from "./context-tree.ts";

const route = contextRouteSchema.shape;
const component = { ...route, component_id: z.string().uuid() };
const reference = { ...component, reference_id: z.string().uuid() };
export const contextOperations = {
  list: { schema: z.object({ ...route, limit: contextPageSizeSchema.optional() }).strict(), description: "List every page of scope components. Existing scope visibility required." },
  read: { schema: z.object(component).strict(), description: "Read one component from the complete current scope structure." },
  path: { schema: z.object(component).strict(), description: "Read ancestors, useful siblings and direct children without loading source documents." },
  references: { schema: z.object({ ...component, limit: contextPageSizeSchema.optional() }).strict(), description: "List every page of direct references with ACL-checked resolution." },
  reference: { schema: z.object(reference).strict(), description: "Read a selected authoritative doc/file/task through its normal ACL route; artifact returns a follow-latest navigation descriptor without fetching private catalogs. Unavailable targets are neutral." },
  create: { schema: z.object({ ...route, input: contextCreateSchema }).strict(), description: "Create a root or child. Requires context.edit or scope.manage and visibility; being an agent grants no authority." },
  update: { schema: z.object({ ...component, input: contextUpdateSchema }).strict(), description: "Rename, reorder or reparent with expected row version. context.edit or scope.manage required; conflicts must be surfaced." },
  link: { schema: z.object({ ...component, input: contextLinkSchema }).strict(), description: "Attach a typed reference under context.edit or scope.manage and target ACLs. A link never grants target access." },
  unlink: { schema: z.object({ ...reference, expected_row_version: contextVersionSchema }).strict(), description: "Remove only this reference link with expected row version and context.edit or scope.manage. Target content remains." },
  delete_preview: { schema: z.object(component).strict(), description: "Preview exact subtree and reference counts/token under context.edit or scope.manage. Preview is not deletion authorization." },
  confirmed_delete: { schema: z.object({ ...component, input: contextDeleteSchema }).strict(), description: "Delete the previewed subtree only after actual user authorization and explicit confirmation/token. Linked content survives. Changed preview conflicts require new preview and confirmation; no offline queue." },
} as const;
export type ContextOperation = keyof typeof contextOperations;
export async function executeContextOperation(client: ContextTreeClient, operation: ContextOperation, params: unknown): Promise<unknown> {
  // Parse again at the host boundary; callers may bypass MCP schema validation.
  switch (operation) {
    case "list": { const p = contextOperations.list.schema.parse(params); return client.list(p.workspace_id, p.scope_id, p.limit); }
    case "read": { const p = contextOperations.read.schema.parse(params); return client.read(p.workspace_id, p.scope_id, p.component_id); }
    case "path": { const p = contextOperations.path.schema.parse(params); return client.pathTo(p.workspace_id, p.scope_id, p.component_id); }
    case "references": { const p = contextOperations.references.schema.parse(params); return client.references(p.workspace_id, p.scope_id, p.component_id, p.limit); }
    case "reference": { const p = contextOperations.reference.schema.parse(params); return client.reference(p.workspace_id, p.scope_id, p.component_id, p.reference_id); }
    case "create": { const p = contextOperations.create.schema.parse(params); return client.create(p.workspace_id, p.scope_id, p.input); }
    case "update": { const p = contextOperations.update.schema.parse(params); return client.update(p.workspace_id, p.scope_id, p.component_id, p.input); }
    case "link": { const p = contextOperations.link.schema.parse(params); return client.link(p.workspace_id, p.scope_id, p.component_id, p.input); }
    case "unlink": { const p = contextOperations.unlink.schema.parse(params); return client.unlink(p.workspace_id, p.scope_id, p.component_id, p.reference_id, p.expected_row_version); }
    case "delete_preview": { const p = contextOperations.delete_preview.schema.parse(params); return client.deletePreview(p.workspace_id, p.scope_id, p.component_id); }
    case "confirmed_delete": { const p = contextOperations.confirmed_delete.schema.parse(params); return client.confirmedDelete(p.workspace_id, p.scope_id, p.component_id, p.input); }
  }
}
