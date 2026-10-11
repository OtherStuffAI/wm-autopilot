import { expect, test } from "bun:test";
import { validateProviderRequest } from "./provider-policy.ts";
const valid = { model: "fixture-model", input: [], tools: [{ type: "function", name: "local_shell" }] };
test("provider capability fixes model, disables storage and bounds output", () => {
  expect(validateProviderRequest({ ...valid, store: true, max_output_tokens: 999999 }, "fixture-model"))
    .toMatchObject({ store: false, max_output_tokens: 4096 });
});
test("allows namespaces containing only local function/custom tools", () => {
  expect(validateProviderRequest({ ...valid, tools: [{ type: "namespace", name: "local", tools: [{ type: "function", name: "shell",
    parameters: { type: "object", properties: { audio_url: { type: "string" }, url: { type: "string" } } } }] }] }, "fixture-model").tools).toHaveLength(1);
});
test("native cache/telemetry metadata never selects private remote context", () => {
  const request = validateProviderRequest({ ...valid, prompt_cache_key: "other-project", client_metadata: { url: "http://host" } }, "fixture-model");
  expect(request).not.toHaveProperty("prompt_cache_key");
  expect(request).not.toHaveProperty("client_metadata");
});
test("provider rejects remote tools, private references and arbitrary routing", () => {
  for (const extra of [{ model: "other" }, { previous_response_id: "private-response" },
    { conversation: "private-conversation" }, { url: "http://host" },
    { tools: [{ type: "namespace", tools: [{ type: "mcp", server_url: "http://host" }] }] },
    { tools: [{ type: "mcp", server_url: "http://host" }] }, { tools: [{ type: "web_search" }] },
    { tools: [{ type: "function", name: "shell", parameters: { $ref: "https://host/schema" } }] },
    { input: [{ type: "item_reference", id: "private-item" }] },
    { input: [{ type: "input_file", file_id: "private-file" }] },
    { input: [{ type: "input_image", image_url: "http://host" }] }]) {
    expect(() => validateProviderRequest({ ...valid, ...extra }, "fixture-model")).toThrow();
  }
});
