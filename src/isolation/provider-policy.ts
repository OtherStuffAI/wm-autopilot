export class ProviderPolicyError extends Error {}

export const PROVIDER_LIMITS = Object.freeze({ requestBytes: 256 * 1024, responseBytes: 2 * 1024 * 1024, requests: 8 });
export interface ProviderReply { body: string; contentType: "text/event-stream" | "application/json"; }
export interface ProjectProvider {
  model: string;
  responses(body: Record<string, unknown>, signal: AbortSignal): Promise<ProviderReply>;
}

const allowedFields = new Set(["model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls",
  "reasoning", "text", "stream", "store", "include", "max_output_tokens", "temperature", "top_p", "service_tier", "prompt_cache_key", "client_metadata"]);

export function validateProviderRequest(value: unknown, model: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderPolicyError("Invalid model request");
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).filter((key) => !allowedFields.has(key));
  if (unknown.length) throw new ProviderPolicyError(`Unauthorized model request fields: ${unknown.join(", ")}`);
  if (Buffer.byteLength(JSON.stringify(body)) > PROVIDER_LIMITS.requestBytes) throw new ProviderPolicyError("Model request byte limit exceeded");
  if (body.model !== model) throw new ProviderPolicyError("Model selection denied");
  if (!Array.isArray(body.input)) throw new ProviderPolicyError("Model input must be an inline array");
  function localTool(tool: unknown, depth = 0): boolean {
    if (!tool || typeof tool !== "object" || Array.isArray(tool) || depth > 2) return false;
    const value = tool as Record<string, unknown>;
    const fields = value.type === "namespace" ? ["type", "name", "description", "tools"] :
      value.type === "function" ? ["type", "name", "description", "parameters", "strict", "output_schema", "defer_loading", "allowed_callers", "async"] :
      value.type === "custom" ? ["type", "name", "description", "format", "defer_loading", "allowed_callers"] : [];
    if (!fields.length || Object.keys(value).some((key) => !fields.includes(key))) return false;
    if (value.type === "namespace") return depth === 0 && Array.isArray(value.tools) && value.tools.length <= 64 && value.tools.every((child) => localTool(child, depth + 1));
    inspectSchema(value.parameters);
    inspectSchema(value.output_schema);
    return true;
  }
  function inspectSchema(value: unknown): void {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && (typeof child !== "string" || !child.startsWith("#/"))) throw new ProviderPolicyError("Remote schema references denied");
      inspectSchema(child);
    }
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || !body.tools.every((tool) => localTool(tool)))) {
    throw new ProviderPolicyError("Only local function/custom tool capabilities are allowed");
  }
  if (body.include !== undefined && (!Array.isArray(body.include) || body.include.some((v) => v !== "reasoning.encrypted_content"))) {
    throw new ProviderPolicyError("Remote model include capability denied");
  }
  function inspect(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) inspect(item); return; }
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && (typeof child !== "string" || !child.startsWith("#/"))) throw new ProviderPolicyError("Remote schema references denied");
      if (key.endsWith("_url") || ["file_id", "url", "previous_response_id", "conversation"].includes(key) ||
        (key === "type" && ((String(child).startsWith("input_") && child !== "input_text") ||
          ["item_reference", "mcp", "web_search", "computer"].includes(String(child))))) {
        throw new ProviderPolicyError(`Unauthorized remote model reference: ${key}`);
      }
      inspect(child);
    }
  }
  // Native transport metadata is not inference authority and never crosses the host gateway.
  const { prompt_cache_key: _cacheKey, client_metadata: _clientMetadata, ...authorized } = body;
  // Function parameter schemas name fields such as audio_url; names are not URL fetches.
  // Their tool roots are validated above and model input references are checked independently.
  const { tools: _tools, ...context } = authorized;
  inspect(context);
  return { ...authorized, store: false, max_output_tokens: Math.min(typeof body.max_output_tokens === "number" &&
    Number.isFinite(body.max_output_tokens) && body.max_output_tokens > 0 ? body.max_output_tokens : 4096, 4096) };
}

export function validateProviderReply(value: ProviderReply): void {
  if (!value || typeof value.body !== "string" || Buffer.byteLength(value.body) > PROVIDER_LIMITS.responseBytes ||
    !["text/event-stream", "application/json"].includes(value.contentType)) throw new Error("Invalid model reply");
}
