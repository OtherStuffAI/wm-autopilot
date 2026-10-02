import { readFileSync } from "node:fs";
import { contextOperations, executeContextOperation, type ContextOperation } from "./context-operations.ts";
import type { ContextTreeClient } from "./context-tree.ts";

export const contextCliHelp = `Context Tree (explicit --workspace and --scope required):
  context-tree list [--limit 200]             All pages; limit is page size
  context-tree read|path|references <component-id>
  context-tree reference <component-id> --reference <reference-id>
  context-tree create --json-file <create.json>
  context-tree update|link <component-id> --json-file <input.json>
  context-tree unlink <component-id> --reference <reference-id> --expected-row-version <n>
  context-tree delete-preview <component-id>
  context-tree confirmed-delete <component-id> --confirmation-token <preview-token> --confirm
Use --json for identity/capabilities/errors and counts. Edits require scope.manage.
Create JSON: {"title":"API","parent_id":null}
Update JSON: {"expected_row_version":1,"title":"Transport"}
Link JSON: {"target_type":"doc","target":{"record_id":"<document-id>"}}
Delete requires actual user authorization, a current preview and --confirm.
No automatic retry, default token, target-access grant or destructive offline queue.`;

export async function runContextCli(client: ContextTreeClient, args: string[], flags: Map<string, string | boolean>) {
  const action = args[1]?.replaceAll("-", "_");
  if (!action || !Object.hasOwn(contextOperations, action)) throw new Error("Unknown context-tree command. Use context-tree help.");
  const get = (flag: string) => typeof flags.get(flag) === "string" ? flags.get(flag) as string : undefined;
  const params: Record<string, unknown> = { workspace_id: get("--workspace"), scope_id: get("--scope") };
  if (!["list", "create"].includes(action)) params.component_id = args[2];
  if (["reference", "unlink"].includes(action)) params.reference_id = get("--reference");
  if (["list", "references"].includes(action) && flags.has("--limit")) params.limit = Number(get("--limit"));
  if (["create", "update", "link"].includes(action)) {
    const path = get("--json-file");
    if (!path) throw new Error("--json-file is required");
    params.input = JSON.parse(readFileSync(path, "utf8"));
  }
  if (action === "unlink") params.expected_row_version = Number(get("--expected-row-version"));
  if (action === "confirmed_delete") params.input = { confirmation_token: get("--confirmation-token"), confirmed: flags.get("--confirm") === true };
  return executeContextOperation(client, action as ContextOperation, params);
}
