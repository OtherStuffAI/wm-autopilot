import { cleanAgentOutputText } from "./agent-output-format.js";

const FIELD_LIMIT = 40;
const PREVIEW_TEXT_LIMIT = 72;
const PIPELINE_PLUMBING_KEYS = new Set([
  "dispatch",
  "routing",
  "runtime",
  "agent",
  "workerAgent",
  "managerAgent",
  "reporterAgent",
  "workspace",
  "callback",
  "callbackUrl",
  "callbackToken",
  "commandPrefix",
  "pipeline",
  "pipelineId",
  "pipelineDefinitionId",
  "pipelineRunId",
  "runId",
  "routeId",
  "triggerKind",
  "source",
  "sourceId",
  "sourceType",
  "channelId",
  "threadId",
  "messageId",
  "botNpub",
  "matchedSelfNpub",
  "shouldProceed",
  "availablePipelines",
  "validChildPipelines",
  "scopes",
  "defaults",
  "hydrated",
  "status",
  "operation",
  "fallbackContext",
  "hydrationWarnings",
  "acknowledgement",
]);

export function buildExplicitDisplayRows(step, direction, options = {}) {
  const specs = step?.metadata?.display?.[direction];
  if (!Array.isArray(specs) || specs.length === 0) return null;
  const rows = specs
    .map((spec) => buildDisplayRow(step, direction, spec, options))
    .filter(Boolean);
  return rows.slice(0, FIELD_LIMIT);
}

export function buildFallbackDisplayRows(value, options = {}) {
  if (!isObjectLike(value)) return [];
  const prefix = options.prefix ?? "";
  const promotedRows = [];
  const genericRows = [];
  for (const [key, childValue] of Object.entries(value)) {
    if (isPipelinePlumbingKey(key) || !isDisplayValue(childValue)) continue;
    const promoted = buildPromotedFallbackRows(prefix, key, childValue);
    if (promoted.length) {
      promotedRows.push(...promoted);
    } else {
      genericRows.push({
        name: joinDisplayPath(prefix, key),
        value: childValue,
      });
    }
  }
  return dedupeRows([
    ...sortPromotedRows(promotedRows),
    ...genericRows,
  ]).slice(0, FIELD_LIMIT);
}

export function buildAssignedOutputRows(assignPath, output) {
  const displayAssignPath = displayPath(assignPath);
  if (!isObjectLike(output)) return [{ name: displayAssignPath, value: output }];
  const entries = Object.entries(output);
  if (!entries.length) return [{ name: displayAssignPath, value: output }];
  const assignLeaf = displayAssignPath.split(".").filter(Boolean).at(-1);
  if (entries.length === 1 && entries[0][0] === assignLeaf) {
    return [{ name: displayAssignPath, value: entries[0][1] }];
  }
  return buildFallbackDisplayRows(output, { prefix: displayAssignPath });
}

export function displayPath(path) {
  return String(path ?? "").replace(/^\$\./, "").replace(/^\$/, "");
}

function buildDisplayRow(step, direction, spec, options) {
  if (!isObjectLike(spec) || typeof spec.label !== "string" || typeof spec.path !== "string") return null;
  if (!hasDisplaySource(step, direction, spec)) return null;
  const value = resolveDisplayValue(step, direction, spec);
  if (value === undefined || value === null || value === "") {
    if (typeof spec.empty !== "string") return null;
    return { name: spec.label, value: spec.empty };
  }
  return {
    name: spec.label,
    value: formatDisplayValue(value, spec, options),
    inspectValue: formatInspectionValue(value, spec, options),
  };
}

function hasDisplaySource(step, direction, spec) {
  const source = typeof spec.source === "string" ? spec.source : direction === "in" ? "input" : "output";
  if (source === "state") return Object.prototype.hasOwnProperty.call(Object(step), "result");
  if (source === "input") return Object.prototype.hasOwnProperty.call(Object(step), "input");
  return Object.prototype.hasOwnProperty.call(Object(step), "output")
    || Object.prototype.hasOwnProperty.call(Object(step), "result");
}

function resolveDisplayValue(step, direction, spec) {
  const source = typeof spec.source === "string" ? spec.source : direction === "in" ? "input" : "output";
  const root = source === "state"
    ? step?.result
    : source === "input"
      ? step?.input
      : getStepOutput(step);
  return resolvePath(root, spec.path);
}

function getStepOutput(step) {
  if (isObjectLike(step?.output)) return step.output;
  if (isObjectLike(step?.result)) return step.result;
  return {};
}

function resolvePath(value, path) {
  if (path === "$" || path === "") return value;
  const parts = displayPath(path).split(".").filter(Boolean);
  let cursor = value;
  for (const part of parts) {
    if (Array.isArray(cursor)) {
      const index = Number(part);
      if (!Number.isInteger(index)) return undefined;
      cursor = cursor[index];
    } else if (isObjectLike(cursor)) {
      cursor = cursor[part];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function formatDisplayValue(value, spec, options = {}) {
  const format = typeof spec.format === "string" ? spec.format : "auto";
  if (format === "messages") return summariseMessages(value, positiveInteger(spec.limit, 5));
  if (format === "records") return summariseRecords(value, positiveInteger(spec.limit, 4));
  if (format === "list") return summariseList(value, positiveInteger(spec.limit, 5));
  if (format === "count") return countValue(value);
  if (format === "agentText") return cleanAgentOutputText(extractText(value) ?? String(value));
  if (format === "text") return compactText(extractText(value) ?? String(value));
  if (options.cleanAgentText && typeof value === "string") return cleanAgentOutputText(value);
  return value;
}

function formatInspectionValue(value, spec, options = {}) {
  const format = typeof spec.format === "string" ? spec.format : "auto";
  if (format === "count") return value;
  if (format === "agentText") return cleanAgentOutputText(extractText(value) ?? String(value));
  if (format === "text") return extractText(value) ?? String(value);
  if (options.cleanAgentText && typeof value === "string") return cleanAgentOutputText(value);
  return value;
}

function summariseMessages(value, limit) {
  const messages = extractArray(value);
  if (!messages.length) return "0 messages";
  const previews = messages
    .slice(-limit)
    .map((message) => {
      const record = isObjectLike(message) ? message : { body: message };
      const author = extractText(record.authorName ?? record.author ?? record.senderName ?? record.senderNpub ?? record.sender_npub ?? record.npub);
      const body = extractText(record.body ?? record.message ?? record.text ?? record.content ?? record.payload);
      return [author, compactText(body, 52)].filter(Boolean).join(": ");
    })
    .filter(Boolean);
  const prefix = `${messages.length} message${messages.length === 1 ? "" : "s"}`;
  return previews.length ? `${prefix}: ${previews.join(" | ")}` : prefix;
}

function buildPromotedFallbackRows(prefix, key, value) {
  const rows = [];
  const lowerKey = String(key).toLowerCase();
  if (lowerKey === "selfauthored" && typeof value === "boolean") {
    return [{ name: "Self Authored", value }];
  }
  if (lowerKey === "suppressionreason" && typeof value === "string" && value.trim()) {
    return [{ name: "Suppression Reason", value }];
  }
  if (!isObjectLike(value)) return rows;

  const messageText = extractText(value.messageText ?? value.body ?? value.message ?? value.text ?? value.payload);
  if (messageText && (lowerKey === "chat" || lowerKey === "message" || lowerKey === "record")) {
    rows.push({
      name: "Chat Message",
      value: compactText(messageText),
      inspectValue: messageText,
    });
  }

  const threadValue = value.thread ?? value.latestThread ?? value.messages ?? value.recent_messages ?? value.recentMessages;
  if (threadValue !== undefined) {
    const threadSummary = summariseMessages(threadValue, positiveInteger(value.threadDisplayLimit, 20));
    if (threadSummary !== "0 messages") {
      rows.push({
        name: "Thread",
        value: threadSummary,
        inspectValue: threadValue,
      });
    }
  }

  if (typeof value.selfAuthored === "boolean") {
    rows.push({
      name: "Self Authored",
      value: value.selfAuthored,
    });
  }

  if (typeof value.suppressionReason === "string" && value.suppressionReason.trim()) {
    rows.push({
      name: "Suppression Reason",
      value: value.suppressionReason,
    });
  }

  return rows;
}

function sortPromotedRows(rows) {
  const priority = new Map([
    ["Chat Message", 0],
    ["Thread", 1],
    ["Self Authored", 2],
    ["Suppression Reason", 3],
  ]);
  return [...rows].sort((left, right) => {
    const leftPriority = priority.get(left.name) ?? 100;
    const rightPriority = priority.get(right.name) ?? 100;
    return leftPriority - rightPriority;
  });
}

function dedupeRows(rows) {
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const key = `${row.name}\u0000${JSON.stringify(row.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function summariseRecords(value, limit) {
  const records = extractArray(value);
  if (!records.length) return "0 records";
  const previews = records
    .slice(0, limit)
    .map((record) => {
      if (!isObjectLike(record)) return compactText(String(record), 52);
      return compactText(extractText(record.title ?? record.name ?? record.summary ?? record.recordId ?? record.id), 52);
    })
    .filter(Boolean);
  const prefix = `${records.length} record${records.length === 1 ? "" : "s"}`;
  return previews.length ? `${prefix}: ${previews.join(" | ")}` : prefix;
}

function summariseList(value, limit) {
  const items = extractArray(value);
  if (!items.length) return "0 items";
  const previews = items
    .slice(0, limit)
    .map((item) => compactText(extractText(item) ?? String(item), 42))
    .filter(Boolean);
  const prefix = `${items.length} item${items.length === 1 ? "" : "s"}`;
  return previews.length ? `${prefix}: ${previews.join(" | ")}` : prefix;
}

function countValue(value) {
  if (Array.isArray(value)) return value.length;
  if (isObjectLike(value)) return Object.keys(value).length;
  return value === undefined || value === null || value === "" ? 0 : 1;
}

function extractArray(value) {
  if (Array.isArray(value)) return value;
  if (!isObjectLike(value)) return [];
  const thread = isObjectLike(value.thread) ? value.thread : value;
  for (const key of ["recent_messages", "recentMessages", "messages", "items", "records"]) {
    if (Array.isArray(thread[key])) return thread[key];
  }
  return [];
}

function extractText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!isObjectLike(value)) return null;
  for (const key of ["body", "message", "text", "content", "summary", "title", "name"]) {
    if (typeof value[key] === "string") return value[key];
  }
  return null;
}

function compactText(value, maxLength = PREVIEW_TEXT_LIMIT) {
  if (!value) return "";
  const compact = String(value).replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function joinDisplayPath(prefix, key) {
  const cleanPrefix = displayPath(prefix);
  const cleanKey = displayPath(key);
  if (!cleanPrefix) return cleanKey;
  if (!cleanKey) return cleanPrefix;
  return `${cleanPrefix}.${cleanKey}`;
}

function isPipelinePlumbingKey(key) {
  const normalized = displayPath(key).split(".").filter(Boolean).at(-1) ?? "";
  return PIPELINE_PLUMBING_KEYS.has(normalized);
}

function isDisplayValue(value) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return false;
  if (isObjectLike(value) && !Array.isArray(value) && Object.keys(value).length === 0) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function isObjectLike(value) {
  return value !== null && typeof value === "object";
}
