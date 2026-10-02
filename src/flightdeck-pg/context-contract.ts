import { z } from "zod";

const id = z.string().uuid();
const title = z.string().trim().min(1).max(256);
export const contextVersionSchema = z.number().int().positive();
const order = z.number().int().nonnegative().max(2147483646);
const slug = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const artifactTargetSchema = z.object({
  origin: z.string().superRefine((value, ctx) => {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        !["", "/"].includes(url.pathname) || url.search || url.hash) throw new Error();
    } catch { ctx.addIssue({ code: "custom", message: "Expected HTTP(S) origin without credentials, path, query or fragment" }); }
  }).transform(value => new URL(value).origin),
  project: slug, artifact: slug, page: z.literal("index.html"), version_policy: z.literal("latest"),
}).strict();
export const contextLinkSchema = z.discriminatedUnion("target_type", [
  z.object({ target_type: z.literal("doc"), target: z.object({ record_id: id }).strict(), sort_order: order.optional() }).strict(),
  z.object({ target_type: z.literal("file"), target: z.object({ record_id: id }).strict(), sort_order: order.optional() }).strict(),
  z.object({ target_type: z.literal("task"), target: z.object({ record_id: id }).strict(), sort_order: order.optional() }).strict(),
  z.object({ target_type: z.literal("artifact"), target: artifactTargetSchema, sort_order: order.optional() }).strict(),
]);
export const contextCreateSchema = z.object({ title, parent_id: id.nullable().optional(), sort_order: order.optional() }).strict();
export const contextUpdateSchema = z.object({
  expected_row_version: contextVersionSchema, title: title.optional(), parent_id: id.nullable().optional(), sort_order: order.optional(),
}).strict().refine(value => value.title !== undefined || value.parent_id !== undefined || value.sort_order !== undefined, "An edit is required");
export const contextDeleteSchema = z.object({
  confirmation_token: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true).describe("Explicit confirmation after preview and actual user deletion authorization"),
}).strict();
export const contextRouteSchema = z.object({ workspace_id: id, scope_id: id });
export const contextPageSizeSchema = z.number().int().min(1).max(200);
export type ContextLink = z.infer<typeof contextLinkSchema>;
export type ContextCreate = z.infer<typeof contextCreateSchema>;
export type ContextUpdate = z.infer<typeof contextUpdateSchema>;
export type ContextDelete = z.infer<typeof contextDeleteSchema>;
export interface ContextComponent {
  id: string; workspace_id: string; scope_id: string; title: string; parent_id: string | null;
  sort_order: number; row_version: number; created_at: string; updated_at: string; deleted_at: string | null;
}
export type ContextReference = ContextLink & {
  id: string; workspace_id: string; scope_id: string; component_id: string; sort_order: number;
  row_version: number; created_at: string; updated_at: string; deleted_at: string | null;
  resolution: { status: "available"; record_id: string; title: string } | { status: "unavailable" | "external" };
};
export interface ContextEnvelope { identity: Record<string, unknown>; capabilities: { read: boolean; manage: boolean; edit?: boolean; scope_manage?: boolean }; }
export interface ContextPreview {
  component_id: string; component_count: number; descendant_count: number; reference_count: number; confirmation_token: string;
}
export interface ContextMutation extends ContextEnvelope {
  audit: { event_id: string; operation: string; actor_npub: string };
  outbox: Array<{ id: string; row_version: number }>; mutation_id: string;
}
export function contextId(value: string): string { return id.parse(value); }
export function artifactContextUrl(target: z.infer<typeof artifactTargetSchema>): string {
  const parsed = artifactTargetSchema.parse(target);
  return `${parsed.origin}/artifacts/${parsed.project}/${parsed.artifact}/`;
}
