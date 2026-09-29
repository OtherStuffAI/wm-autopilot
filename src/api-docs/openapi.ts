import { schemas, runExample, acceptedExample } from "./schemas";
import { endpointCatalog } from "./endpoint-catalog";

const nip98 = [{ NIP98: [] }];
const jsonResponse = (description: string, schema: Record<string, unknown>, example?: unknown) => ({ description,
  content: { "application/json": { schema, ...(example === undefined ? {} : { example }) } } });
const envelope = { $ref: "#/components/schemas/RunEnvelope" };
const error = { $ref: "#/components/schemas/Error" };
const errors = Object.fromEntries([
  ["400", "Invalid JSON, mode, wait, idempotency key, learning input or unsafe webhook URL"],
  ["401", "Authentication required or invalid NIP-98 event"], ["403", "Current authorization policy denies access"],
  ["404", "Not found or outside caller ownership"], ["409", "Idempotency conflict or invalid run state"],
  ["500", "Failure before a run could be accepted; retry with the same idempotency key and a fresh NIP-98 event"],
  ["503", "Required runtime service unavailable"],
].map(([status, description]) => [status!, jsonResponse(description!, error)]));
const idParameter = { name: "id", in: "path", required: true, schema: { type: "string" } };

export function createOpenApiSpec() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [method, path, summary, access, source] of endpointCatalog) {
    const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map(match => ({ name: match[1], in: "path", required: true, schema: { type: "string" } }));
    const stream = path.endsWith("/events");
    (paths[path] ??= {})[method] = {
      operationId: `${method}_${path.replace(/[^a-zA-Z0-9]+/g, "_")}`, summary, tags: [path.split("/")[2]],
      description: `Verified route inventory. Access: ${access}. This entry documents route and authority; variable request/response DTOs remain open. See the implementation source for operation-specific fields.`,
      security: nip98, parameters, "x-source-file": source, "x-access-policy": access,
      responses: {
        "200": stream ? { description: "Session SSE stream", content: { "text/event-stream": { schema: { type: "string" } } } }
          : jsonResponse("Successful response (operation-specific object)", { type: "object", additionalProperties: true }),
        ...(method === "post" ? { "201": jsonResponse("Resource created, where supported", { type: "object", additionalProperties: true }) } : {}),
        "401": errors["401"], "403": errors["403"], "404": errors["404"],
      },
    };
  }
  paths["/api/pipelines/definitions/{id}/runs"] = { post: {
    operationId: "startPipeline", tags: ["pipelines"], summary: "Call a pipeline: wait, poll, or signed webhook",
    description: "Default wait mode uses at most 60 seconds of HTTP execution wait. HTTP 200 means a terminal run, including status=error, needs_input or cancelled: inspect status/error. HTTP 202 means accepted/running; timedOut=true marks wait expiry. The same durable run continues; never retry to poll. mode=poll or webhook returns HTTP 202 immediately after acceptance. Legacy ?async=1 selects poll when mode is omitted. Explicit mode takes precedence. Pre-acceptance validation/access errors use HTTP 4xx/5xx with Error. An optional idempotency key is scoped to caller and resolved definition ID. Matching input/webhook returns the original run; changes return 409. Wait settings/mode may change without starting another run when the webhook target is unchanged. No key means each POST starts a run. Keys have no automatic expiry. Public calls remain owner-private even on a shared instance; existing shared run visibility is preserved. Learning definitions additionally require their existing input.idempotencyKey and authorized session-bound Tower context.",
    security: nip98, "x-source-file": "src/pipelines/public-call-routes.ts", "x-access-policy": "sessions:manage; current approved caller/admin or explicit execution delegation policy",
    parameters: [idParameter, { name: "async", in: "query", schema: { type: "string", enum: ["1"] }, description: "Legacy polling mode" },
      { name: "Idempotency-Key", in: "header", schema: { type: "string", minLength: 1, maxLength: 200 }, description: "Optional alternative to body key. Put key in the body to cryptographically bind it via NIP-98 payload; both must match if supplied." }],
    requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/StartPipeline" }, examples: {
      wait: { value: { mode: "wait", waitSeconds: 60, idempotencyKey: "report-2026-01", input: { topic: "Quarterly report" } } },
      poll: { value: { mode: "poll", idempotencyKey: "report-2026-02", input: { topic: "Quarterly report" } } },
      webhook: { value: { mode: "webhook", idempotencyKey: "report-2026-03", input: { topic: "Quarterly report" }, webhook: { url: "https://receiver.example/pipeline-result" } } },
    } } } },
    responses: {
      "200": jsonResponse("Terminal result (pipeline errors are represented by status and error)", envelope, runExample),
      "202": { ...jsonResponse("Accepted or wait expired; continue polling this run", envelope, { ...acceptedExample, timedOut: true }),
        headers: { Location: { description: "Relative polling URL for the same run", schema: { type: "string" } } } }, ...errors,
    },
    callbacks: { terminalResult: { "{$request.body#/webhook/url}": { post: {
      summary: "Signed terminal pipeline result (webhook mode only)", security: nip98,
      description: "Autopilot signs NIP-98 with its instance public key, independently of the caller. Pin the key from authenticated GET /api/pipelines/webhook-signer using a trusted host. Verify event signature/kind/time/exact receiver URL/POST/body hash. Signed delivery/run/attempt tags bind identity; deliveryId and runId are in the immutable body and matching X-Wingman headers. Atomically deduplicate deliveryId before business effects; return 2xx for already applied deliveries. At most five attempts; exponential 1/2/4/8 second retry delays, 10-second network deadline plus at most 5 seconds DNS; crashed attempts recover after a 30-second lease. Non-2xx, transport or destination failures retry. No redirects. Terminal delivery is independent of run completion; inspect delivery URL and poll even after failure. A resumed terminal run does not emit a second delivery; the first snapshot is immutable.",
      parameters: [{ name: "X-Wingman-Delivery-Id", in: "header", required: true, schema: { type: "string" } }, { name: "X-Wingman-Run-Id", in: "header", required: true, schema: { type: "string" } }],
      requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookResult" }, example: { deliveryId: "8331bafb-8dd0-4c7d-94f1-ad841977d197", ...runExample } } } },
      responses: { "200": { description: "Result durably applied or duplicate acknowledged" } },
    } } } },
  } };
  paths["/api/pipelines/runs/{id}"] = { get: {
    operationId: "getPipelineRun", summary: "Poll status and result", tags: ["pipelines"], security: nip98, parameters: [idParameter,
      { name: "includeRunPayload", in: "query", schema: { type: "string", enum: ["1"] }, description: "Legacy full run record" },
      { name: "includePayload", in: "query", schema: { type: "string", enum: ["1"] }, description: "Legacy full run and step payloads" }],
    description: "Top-level result/error/status use the same envelope as start and webhook. Existing run and steps fields remain available. Public calls are owner-private; internal callback tokens are removed from their step records. No webhook delivery dependency.",
    "x-source-file": "src/pipelines/pipeline-api-routes.ts", "x-access-policy": "sessions:manage; public call owner only; legacy visibility follows instance policy",
    responses: { "200": jsonResponse("Current status and durable result", envelope, runExample), ...errors },
  } };
  paths["/api/pipelines/runs/{id}/delivery"] = { get: {
    operationId: "getPipelineDelivery", summary: "Inspect webhook delivery independently of execution", tags: ["pipelines"], security: nip98,
    parameters: [idParameter], "x-source-file": "src/pipelines/pipeline-api-routes.ts", "x-access-policy": "sessions:manage; run owner only",
    responses: { "200": jsonResponse("Run envelope plus delivery record (null without a webhook)", { $ref: "#/components/schemas/DeliveryEnvelope" }), ...errors },
  } };
  paths["/api/pipelines/webhook-signer"] = { get: {
    operationId: "getWebhookSigner", summary: "Discover public result webhook signing key", tags: ["pipelines"], security: nip98,
    "x-source-file": "src/pipelines/pipeline-api-routes.ts", "x-access-policy": "sessions:manage",
    responses: { "200": jsonResponse("Public instance key only; pin it through your trusted Autopilot origin", { type: "object", required: ["pubkey", "scheme"], properties: { pubkey: { type: "string", nullable: true }, scheme: { type: "string", enum: ["NIP-98"] } } }), ...errors },
  } };
  return {
    openapi: "3.0.3", info: { title: "Autopilot public API", version: "1.0.0",
      description: "Autopilot runs agents, pipelines, schedules and WApps; Tower owns shared backend state. This catalog is a curated, verified NIP-98-capable surface, not every internal API. Cookies may also work where routes permit them. Authentication is not authorization: existing owner, approval, admin and execution delegation checks still apply. NIP-98 kind 27235 must bind one u tag to the exact absolute public request URL including query encoding/order and one method tag to the uppercase HTTP method. Nonempty bodies REQUIRE one payload tag containing lowercase hex SHA-256 of the exact transmitted bytes; empty bodies MUST omit payload. Events expire after 60 seconds with 15 seconds future skew and are replay-protected. Sign a fresh event for EVERY retry/poll; reuse the body idempotencyKey, never the auth event. Configured public base URL supplies the origin behind proxies; path and query are retained. Never expose a signing key or credential. Cross-origin browser calls only support the pipeline calling subset with an explicit WINGMEN_PIPELINE_CORS_ORIGINS exact-origin allowlist and NIP-98; use credentials:omit. No wildcard or cookie credentials. Internal agent-step callbacks use token auth, HTTP triggers have separate configured token policy, internal signing/MCP broker routes are not public caller signing APIs, and cookie-only management routes are excluded. Docs are public at /api/docs and /api/docs/openapi.json. Operational deployment origins are not hardcoded." },
    servers: [{ url: "/", description: "This Autopilot origin" }], paths,
    components: { securitySchemes: { NIP98: { type: "apiKey", in: "header", name: "Authorization", description: "Nostr <base64(JSON signed kind-27235 event)>; freshly sign exact URL, uppercase method and nonempty body SHA-256 for every request. Swagger's browser NIP-07 signer interceptor handles this when window.nostr is available." } }, schemas },
  };
}
