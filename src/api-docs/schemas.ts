export const pipelineStatuses = ["queued", "running", "ok", "needs_input", "error", "skipped", "cancelled"];
const nullableObject = { type: "object", nullable: true, additionalProperties: true };
export const schemas = {
  Error: { type: "object", required: ["error"], properties: { error: { type: "string" }, code: { type: "string" } } },
  RunEnvelope: {
    type: "object", required: ["runId", "status", "terminal", "result", "error", "pollingUrl", "deliveryUrl"],
    properties: {
      runId: { type: "string" }, status: { type: "string", enum: pipelineStatuses }, terminal: { type: "boolean" },
      result: nullableObject, error: { type: "string", nullable: true }, pollingUrl: { type: "string" }, deliveryUrl: { type: "string" },
      run: { type: "object", description: "Legacy run record or summary. Use top-level result for polling.", additionalProperties: true },
      steps: { type: "array", items: { type: "object", additionalProperties: true } },
      timedOut: { type: "boolean" }, replayed: { type: "boolean" },
    },
  },
  StartPipeline: {
    type: "object", oneOf: [
      { required: ["mode", "webhook"], properties: { mode: { enum: ["webhook"] } } },
      { properties: { mode: { enum: ["wait", "poll"] } }, not: { required: ["webhook"] } },
    ], properties: {
      input: { type: "object", additionalProperties: true, default: {} },
      mode: { type: "string", enum: ["wait", "poll", "webhook"], default: "wait" },
      waitSeconds: { type: "number", minimum: 0, maximum: 60, default: 60, description: "Execution wait deadline; never cancels the run." },
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
      webhook: { type: "object", required: ["url"], additionalProperties: false, properties: {
        url: { type: "string", format: "uri", description: "Required for webhook mode; public HTTPS on port 443 without credentials or fragment. Forbidden in other modes." },
      } },
    },
  },
  Delivery: {
    type: "object", required: ["id", "runId", "url", "status", "attempts", "attemptLimit", "nextAttemptAt", "lastError", "lastHttpStatus", "deliveredAt", "retryCount", "retryRequestedAt", "requeues"],
    properties: {
      id: { type: "string" }, runId: { type: "string" }, url: { type: "string", format: "uri" },
      status: { type: "string", enum: ["pending", "delivering", "delivered", "failed"] },
      attempts: { type: "integer", minimum: 0 }, attemptLimit: { type: "integer", minimum: 5, description: "End of the current bounded five-attempt delivery window." },
      nextAttemptAt: { type: "integer", description: "Unix milliseconds; a delivering record uses this as its recovery lease expiry." },
      lastError: { type: "string", nullable: true }, lastHttpStatus: { type: "integer", nullable: true },
      deliveredAt: { type: "string", format: "date-time", nullable: true },
      retryCount: { type: "integer", minimum: 0 }, retryRequestedAt: { type: "string", format: "date-time", nullable: true },
      requeues: { type: "array", items: { type: "object", required: ["id", "deliveryId", "retryNumber", "priorAttempts", "priorAttemptLimit", "priorLastError", "priorLastHttpStatus", "requestedAt", "requestedByNpub"], properties: {
        id: { type: "string" }, deliveryId: { type: "string" }, retryNumber: { type: "integer", minimum: 1 },
        priorAttempts: { type: "integer", minimum: 0 }, priorAttemptLimit: { type: "integer", minimum: 5 },
        priorLastError: { type: "string", nullable: true }, priorLastHttpStatus: { type: "integer", nullable: true },
        requestedAt: { type: "string", format: "date-time" }, requestedByNpub: { type: "string" },
      } } },
    },
  },
  DeliveryRetry: { type: "object", required: ["outcome"], properties: {
    outcome: { type: "string", enum: ["requeued", "already_pending", "delivered", "invalid", "denied"] },
    code: { type: "string", enum: ["delivery_not_found", "not_public_call", "delivery_absent", "run_not_terminal", "delivery_payload_absent"] },
    error: { type: "string" }, delivery: { $ref: "#/components/schemas/Delivery" },
  } },
  DeliveryEnvelope: { allOf: [{ $ref: "#/components/schemas/RunEnvelope" }, {
    type: "object", required: ["delivery"], properties: { delivery: { anyOf: [{ $ref: "#/components/schemas/Delivery" }, { type: "object", nullable: true, enum: [null] }] } },
  }] },
  WebhookResult: { allOf: [{ $ref: "#/components/schemas/RunEnvelope" }, {
    type: "object", required: ["deliveryId"], properties: { deliveryId: { type: "string" } },
  }] },
};

export const runExample = {
  runId: "8b7e40cc-540b-4ab3-9049-f21c997562a1", status: "ok", terminal: true,
  result: { summary: "Ready" }, error: null,
  pollingUrl: "/api/pipelines/runs/8b7e40cc-540b-4ab3-9049-f21c997562a1",
  deliveryUrl: "/api/pipelines/runs/8b7e40cc-540b-4ab3-9049-f21c997562a1/delivery",
};
export const acceptedExample = { ...runExample, status: "running", terminal: false, result: null, timedOut: false };
