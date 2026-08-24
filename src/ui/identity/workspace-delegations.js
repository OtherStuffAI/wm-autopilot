import { signIdentityEvent } from "./event-signer.js";

export const WORKSPACE_DELEGATION_EVENT_KIND = 30079;
export const WORKSPACE_DELEGATION_KIND = "wingman-delegation-v1";

export const WORKSPACE_DELEGATION_SCOPE_OPTIONS = [
  { value: "sessions:read", label: "Read sessions", defaultChecked: true },
  { value: "sessions:create", label: "Create sessions", defaultChecked: true },
  { value: "sessions:manage", label: "Manage sessions", defaultChecked: true },
  { value: "sessions:message", label: "Send messages", defaultChecked: true },
  { value: "apps:read", label: "Read apps", defaultChecked: false },
  { value: "apps:operate", label: "Operate apps", defaultChecked: false },
  { value: "apps:configure", label: "Configure apps", defaultChecked: false },
  { value: "apps:build", label: "Build apps", defaultChecked: false },
  { value: "apps:manage", label: "Manage apps (legacy umbrella)", defaultChecked: false },
  { value: "deployments:manage", label: "Manage deployments", defaultChecked: false },
  { value: "wapps:read", label: "Read WApp assignments", defaultChecked: false },
  { value: "wapps:install", label: "Install WApps", defaultChecked: false },
  { value: "wapps:assign", label: "Assign WApps", defaultChecked: false },
  { value: "files:read", label: "Read files", defaultChecked: false },
  { value: "files:write", label: "Write files", defaultChecked: false },
];

export const WORKSPACE_DELEGATION_DURATION_OPTIONS = [
  { value: "none", label: "Unlimited" },
  { value: "7", label: "7 days" },
  { value: "21", label: "21 days" },
  { value: "30", label: "30 days" },
];

function parseJsonResponse(response, payload, fallbackMessage) {
  if (response.ok) {
    return payload;
  }
  const message =
    payload && typeof payload === "object" && typeof payload.error === "string"
      ? payload.error
      : `${fallbackMessage} (${response.status})`;
  throw new Error(message);
}

function uniqueStringList(values) {
  return Array.from(
    new Set(
      values
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value.length > 0),
    ),
  );
}

export function parseLineList(value) {
  if (typeof value !== "string") {
    return [];
  }
  return uniqueStringList(value.split(/\r?\n|,/));
}

function parseSpendLimit(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error("Spend limit must be a non-negative integer");
  }
  return Math.trunc(numeric);
}

function resolveExpiryTimestamp(durationValue, createdAt) {
  if (durationValue === "none") {
    return null;
  }
  const days = Number.parseInt(String(durationValue), 10);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error("Delegation duration is invalid");
  }
  return createdAt + days * 24 * 60 * 60 * 1000;
}

function buildResourceFilters(filtersInput) {
  const resourceFilters = {};
  const pathPrefixes = parseLineList(filtersInput.pathPrefixes);
  const appIds = parseLineList(filtersInput.appIds);
  const appRoots = parseLineList(filtersInput.appRoots);
  const projectRoots = parseLineList(filtersInput.projectRoots);
  const triggerIds = parseLineList(filtersInput.triggerIds);
  const wappIds = parseLineList(filtersInput.wappIds);
  const workspaceIds = parseLineList(filtersInput.workspaceIds);
  const scopeIds = parseLineList(filtersInput.scopeIds);

  if (pathPrefixes.length > 0) {
    resourceFilters.pathPrefixes = pathPrefixes;
  }
  if (appIds.length > 0) {
    resourceFilters.appIds = appIds;
  }
  if (appRoots.length > 0) {
    resourceFilters.appRoots = appRoots;
  }
  if (projectRoots.length > 0) {
    resourceFilters.projectRoots = projectRoots;
  }
  if (triggerIds.length > 0) resourceFilters.triggerIds = triggerIds;
  if (wappIds.length > 0) resourceFilters.wappIds = wappIds;
  if (workspaceIds.length > 0) resourceFilters.workspaceIds = workspaceIds;
  if (scopeIds.length > 0) resourceFilters.scopeIds = scopeIds;

  return Object.keys(resourceFilters).length > 0 ? resourceFilters : undefined;
}

export function buildWorkspaceDelegationPayload(input) {
  const ownerNpub = typeof input.ownerNpub === "string" ? input.ownerNpub.trim() : "";
  const delegateNpub = typeof input.delegateNpub === "string" ? input.delegateNpub.trim() : "";
  const scopes = uniqueStringList(Array.isArray(input.scopes) ? input.scopes : []);
  if (!ownerNpub) {
    throw new Error("Owner npub is required");
  }
  if (!delegateNpub) {
    throw new Error("Delegate npub is required");
  }
  if (scopes.length === 0) {
    throw new Error("Select at least one delegation scope");
  }

  const createdAt = Date.now();
  return {
    kind: WORKSPACE_DELEGATION_KIND,
    ownerNpub,
    delegateNpub,
    scopes,
    resourceFilters: buildResourceFilters(input),
    billingMode: input.billingMode === "owner" || input.billingMode === "shared" ? input.billingMode : "delegate",
    spendLimitSats: parseSpendLimit(input.spendLimitSats),
    createdAt,
    expiresAt: resolveExpiryTimestamp(input.duration, createdAt),
  };
}

export async function listWorkspaceDelegations({ ownerNpub, onUnauthorized } = {}) {
  const path = ownerNpub
    ? `/api/owners/${encodeURIComponent(ownerNpub)}/delegations`
    : "/api/delegations";
  const response = await fetch(path, { credentials: "include" });
  if (response.status === 401) {
    onUnauthorized?.();
  }
  const payload = await response.json().catch(() => null);
  return parseJsonResponse(response, payload, "Failed to load delegations");
}

export async function createWorkspaceDelegation(input, { onUnauthorized } = {}) {
  const payload = buildWorkspaceDelegationPayload(input);
  const signedEvent = await signIdentityEvent({
    kind: WORKSPACE_DELEGATION_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify(payload),
  });

  const response = await fetch("/api/delegations", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedEvent }),
  });
  if (response.status === 401) {
    onUnauthorized?.();
  }
  const body = await response.json().catch(() => null);
  return parseJsonResponse(response, body, "Failed to create delegation");
}

export async function revokeWorkspaceDelegation(id, { onUnauthorized } = {}) {
  const response = await fetch(`/api/delegations/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (response.status === 401) {
    onUnauthorized?.();
  }
  const body = await response.json().catch(() => null);
  return parseJsonResponse(response, body, "Failed to revoke delegation");
}

function formatTimestamp(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "Never";
  }
  return new Date(timestamp).toLocaleString();
}

function describeStatus(record) {
  if (Number.isFinite(record?.revokedAt) && record.revokedAt > 0) {
    return {
      label: `Revoked ${formatTimestamp(record.revokedAt)}`,
      state: "revoked",
      revokable: false,
    };
  }
  if (Number.isFinite(record?.expiresAt) && record.expiresAt > 0 && record.expiresAt <= Date.now()) {
    return {
      label: `Expired ${formatTimestamp(record.expiresAt)}`,
      state: "expired",
      revokable: false,
    };
  }
  return {
    label: record?.expiresAt ? `Active until ${formatTimestamp(record.expiresAt)}` : "Active with no expiry",
    state: "active",
    revokable: true,
  };
}

function summariseFilters(filters) {
  if (!filters || typeof filters !== "object") {
    return "Unrestricted within owner workspace";
  }
  const parts = [];
  if (Array.isArray(filters.pathPrefixes) && filters.pathPrefixes.length > 0) {
    parts.push(`paths: ${filters.pathPrefixes.join(", ")}`);
  }
  if (Array.isArray(filters.appIds) && filters.appIds.length > 0) {
    parts.push(`apps: ${filters.appIds.join(", ")}`);
  }
  if (Array.isArray(filters.appRoots) && filters.appRoots.length > 0) {
    parts.push(`app roots: ${filters.appRoots.join(", ")}`);
  }
  if (Array.isArray(filters.projectRoots) && filters.projectRoots.length > 0) {
    parts.push(`project roots: ${filters.projectRoots.join(", ")}`);
  }
  if (Array.isArray(filters.triggerIds) && filters.triggerIds.length > 0) parts.push(`triggers: ${filters.triggerIds.join(", ")}`);
  if (Array.isArray(filters.wappIds) && filters.wappIds.length > 0) parts.push(`WApps: ${filters.wappIds.join(", ")}`);
  if (Array.isArray(filters.workspaceIds) && filters.workspaceIds.length > 0) parts.push(`workspaces: ${filters.workspaceIds.join(", ")}`);
  if (Array.isArray(filters.scopeIds) && filters.scopeIds.length > 0) parts.push(`scopes: ${filters.scopeIds.join(", ")}`);
  return parts.length > 0 ? parts.join(" | ") : "Unrestricted within owner workspace";
}

function appendMetaRow(list, term, description) {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = description;
  list.append(dt, dd);
}

function createDelegationListItem(record) {
  const item = document.createElement("article");
  item.className = "wm-identity-delegations__item";
  item.dataset.delegationId = record.id;
  item.dataset.testid = "workspace-delegation-item";

  const header = document.createElement("div");
  header.className = "wm-identity-delegations__item-header";

  const titleBlock = document.createElement("div");
  titleBlock.className = "wm-identity-delegations__item-title";

  const title = document.createElement("h4");
  title.textContent = record.delegateNpub;
  title.title = record.delegateNpub;
  titleBlock.append(title);

  const status = describeStatus(record);
  const statusLine = document.createElement("p");
  statusLine.className = "wm-identity-delegations__status";
  statusLine.dataset.state = status.state;
  statusLine.textContent = status.label;
  titleBlock.append(statusLine);

  header.append(titleBlock);

  if (status.revokable) {
    const revokeButton = document.createElement("button");
    revokeButton.type = "button";
    revokeButton.className = "wm-button secondary wm-button--small";
    revokeButton.dataset.action = "workspace-delegation-revoke";
    revokeButton.dataset.delegationId = record.id;
    revokeButton.dataset.testid = "workspace-delegation-revoke";
    revokeButton.textContent = "Revoke";
    revokeButton.setAttribute("aria-label", `Revoke delegation for ${record.delegateNpub}`);
    header.append(revokeButton);
  }

  const meta = document.createElement("dl");
  meta.className = "wm-identity-delegations__meta";
  appendMetaRow(meta, "Scopes", Array.isArray(record.scopes) && record.scopes.length > 0 ? record.scopes.join(", ") : "None");
  appendMetaRow(meta, "Billing", record.billingMode ?? "delegate");
  appendMetaRow(meta, "Created", formatTimestamp(record.createdAt));
  appendMetaRow(meta, "Spend limit", Number.isFinite(record.spendLimitSats) ? `${record.spendLimitSats} sats` : "None");
  appendMetaRow(meta, "Filters", summariseFilters(record.resourceFilters));

  item.append(header, meta);
  return item;
}

export function renderWorkspaceDelegationList(container, delegations) {
  if (!container) {
    return;
  }
  container.replaceChildren();
  if (!Array.isArray(delegations) || delegations.length === 0) {
    const empty = document.createElement("p");
    empty.className = "wm-identity-delegations__empty";
    empty.textContent = "No workspace delegations have been granted yet.";
    container.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  delegations.forEach((record) => {
    fragment.append(createDelegationListItem(record));
  });
  container.append(fragment);
}
