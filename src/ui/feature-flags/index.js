import { showDialogElement } from "../common/dialog-element.js";

export const FEATURE_FLAG_STATES = ["off", "on_admin", "on"];
export const FEATURE_FLAG_STATE_LABELS = {
  off: "Off for everyone",
  on_admin: "Admin only",
  on: "On for everyone",
};
export const ORCHESTRATOR_FLAG_KEY = "orchestrator_visibility";
export const PROJECTS_FLAG_KEY = "projects_visibility";

export const createFeatureFlagsState = () => ({
  items: [],
  loading: false,
  initialized: false,
  error: null,
  pending: new Set(),
  create: {
    key: "",
    label: "",
    description: "",
    state: "off",
    submitting: false,
    error: null,
    success: null,
  },
});

const normaliseFeatureFlagKeyInput = (value) => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.replace(/[^a-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
};

const normaliseFeatureFlagStateValue = (value) => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return FEATURE_FLAG_STATES.includes(normalized) ? normalized : null;
};

const resolveFeatureFlagEffectiveState = (state, viewerIsAdmin) => {
  if (state === "on") return "on";
  if (state === "on_admin") return viewerIsAdmin ? "on" : "off";
  return "off";
};

const normaliseFeatureFlagRecord = (flag, viewerIsAdmin) => {
  if (!flag || typeof flag !== "object") return null;
  const key = normaliseFeatureFlagKeyInput(flag.key);
  if (!key) return null;
  const label =
    typeof flag.label === "string" && flag.label.trim().length > 0
      ? flag.label.trim()
      : key;
  const description =
    typeof flag.description === "string" && flag.description.trim().length > 0
      ? flag.description.trim()
      : null;
  const stateValue = normaliseFeatureFlagStateValue(flag.state) ?? "off";
  const effectiveState =
    normaliseFeatureFlagStateValue(flag.effectiveState) ??
    resolveFeatureFlagEffectiveState(stateValue, viewerIsAdmin);
  const updatedAt = typeof flag.updatedAt === "string" ? flag.updatedAt : null;
  const updatedBy =
    typeof flag.updatedBy === "string" && flag.updatedBy.trim().length > 0
      ? flag.updatedBy.trim()
      : null;
  return {
    key,
    label,
    description,
    state: stateValue,
    effectiveState,
    updatedAt,
    updatedBy,
  };
};

export const initFeatureFlagsUI = ({ state, render, showToast, abbreviateNpub }) => {
  const dialog = document.getElementById("feature-flags-dialog");
  const form = dialog?.querySelector("form");
  const keyInput = dialog?.querySelector('[name="flag-key"]');
  const labelInput = dialog?.querySelector('[name="flag-label"]');
  const descriptionInput = dialog?.querySelector('[name="flag-description"]');
  const stateSelect = dialog?.querySelector('[name="flag-state"]');
  const submitButton = dialog?.querySelector('[data-action="submit-flag"]');
  const cancelButton = dialog?.querySelector('[data-action="cancel-flag"]');
  const statusMessage = dialog?.querySelector('[data-role="flag-status"]');

  const viewerIsAdmin = () => Boolean(state.identity?.isAdmin);

  const replaceFeatureFlags = (flags) => {
    if (!Array.isArray(flags)) return;
    const items = flags
      .map((flag) => normaliseFeatureFlagRecord(flag, viewerIsAdmin()))
      .filter((flag) => flag && typeof flag.key === "string");
    state.featureFlags.items = items;
    state.featureFlags.initialized = true;
    state.featureFlags.loading = false;
    state.featureFlags.error = null;
    state.featureFlags.pending.clear();
  };

  const upsertFeatureFlag = (flag) => {
    const normalized = normaliseFeatureFlagRecord(flag, viewerIsAdmin());
    if (!normalized) return;
    const items = Array.isArray(state.featureFlags.items) ? [...state.featureFlags.items] : [];
    const idx = items.findIndex((entry) => entry.key === normalized.key);
    if (idx >= 0) {
      items[idx] = normalized;
    } else {
      items.push(normalized);
    }
    items.sort((a, b) => a.label.localeCompare(b.label));
    state.featureFlags.items = items;
    state.featureFlags.initialized = true;
  };

  const syncFormStatus = () => {
    const formState = state.featureFlags.create;
    if (!statusMessage) return;
    statusMessage.textContent = "";
    delete statusMessage.dataset.state;
    if (formState.error) {
      statusMessage.dataset.state = "error";
      statusMessage.textContent = formState.error;
    } else if (formState.success) {
      statusMessage.dataset.state = "success";
      statusMessage.textContent = formState.success;
    }
  };

  const syncFormFields = () => {
    const formState = state.featureFlags.create;
    if (keyInput) keyInput.value = formState.key ?? "";
    if (labelInput) labelInput.value = formState.label ?? "";
    if (descriptionInput) descriptionInput.value = formState.description ?? "";
    if (stateSelect) stateSelect.value = normaliseFeatureFlagStateValue(formState.state) ?? "off";
    syncFormStatus();
  };

  const closeDialog = () => {
    if (dialog && dialog.open) {
      dialog.close();
    }
  };

  const openDialog = () => {
    const formState = state.featureFlags.create;
    formState.error = null;
    formState.success = null;
    syncFormFields();
    if (showDialogElement(dialog)) {
      keyInput?.focus();
    }
  };

  const submitFeatureFlagCreate = async () => {
    if (!viewerIsAdmin()) return;
    const formState = state.featureFlags.create;
    if (formState.submitting) return;

    const key = normaliseFeatureFlagKeyInput(formState.key);
    const label = typeof formState.label === "string" ? formState.label.trim() : "";
    const description = typeof formState.description === "string" ? formState.description.trim() : "";
    const stateValue = normaliseFeatureFlagStateValue(formState.state) ?? "off";

    if (!key) {
      formState.error = "Flag key is required";
      formState.success = null;
      syncFormStatus();
      render();
      return;
    }
    if (!label) {
      formState.error = "Flag label is required";
      formState.success = null;
      syncFormStatus();
      render();
      return;
    }

    formState.submitting = true;
    formState.error = null;
    formState.success = null;
    syncFormFields();
    render();

    try {
      const response = await fetch("/api/feature-flags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          label,
          description: description.length > 0 ? description : null,
          state: stateValue,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to create feature flag";
        throw new Error(message);
      }
      if (Array.isArray(payload?.flags)) {
        replaceFeatureFlags(payload.flags);
      } else if (payload?.flag) {
        upsertFeatureFlag(payload.flag);
      }
      formState.key = "";
      formState.label = "";
      formState.description = "";
      formState.state = stateValue;
      formState.success = "Feature flag created";
      closeDialog();
      showToast?.("Feature flag created");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create feature flag";
      formState.error = message;
      syncFormStatus();
    } finally {
      formState.submitting = false;
      syncFormFields();
      render();
    }
  };

  const fetchFeatureFlags = async () => {
    state.featureFlags.loading = true;
    state.featureFlags.error = null;
    try {
      const response = await fetch("/api/feature-flags");
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to load feature flags";
        throw new Error(message);
      }
      const flags = Array.isArray(payload?.flags) ? payload.flags : [];
      replaceFeatureFlags(flags);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load feature flags";
      state.featureFlags.error = message;
      state.featureFlags.initialized = true;
    } finally {
      state.featureFlags.loading = false;
      render();
    }
  };

  const ensureFeatureFlagsLoaded = () => {
    if (state.featureFlags.loading || state.featureFlags.initialized) {
      return;
    }
    void fetchFeatureFlags();
  };

  const getFeatureFlagRecord = (key) => {
    const normalizedKey = normaliseFeatureFlagKeyInput(key);
    if (!normalizedKey) return null;
    const items = Array.isArray(state.featureFlags.items) ? state.featureFlags.items : [];
    return items.find((flag) => flag.key === normalizedKey) ?? null;
  };

  const resolveFeatureFlagForViewer = (key, { fallbackState = "off" } = {}) => {
    const record = getFeatureFlagRecord(key);
    const fallback = normaliseFeatureFlagStateValue(fallbackState) ?? "off";
    const baseState = record?.state ?? fallback;
    const effectiveState = resolveFeatureFlagEffectiveState(baseState, viewerIsAdmin());
    return { record, state: baseState, effectiveState };
  };

  const isFeatureEnabledForViewer = (key, { fallbackState = "off" } = {}) => {
    const resolved = resolveFeatureFlagForViewer(key, { fallbackState });
    return resolved.effectiveState === "on";
  };

  const projectsFeatureEnabledForViewer = () => {
    return isFeatureEnabledForViewer(PROJECTS_FLAG_KEY, { fallbackState: "on_admin" });
  };

  const updateFeatureFlagState = async (key, nextState) => {
    if (!viewerIsAdmin()) return;
    const normalizedKey = normaliseFeatureFlagKeyInput(key);
    const normalizedState = normaliseFeatureFlagStateValue(nextState);
    if (!normalizedKey || !normalizedState) return;
    const existing = getFeatureFlagRecord(normalizedKey);
    if (!existing) return;
    state.featureFlags.pending.add(normalizedKey);
    render();
    try {
      const response = await fetch(`/api/feature-flags/${encodeURIComponent(normalizedKey)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          state: normalizedState,
          label: existing.label,
          description: existing.description ?? null,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to update feature flag";
        throw new Error(message);
      }
      if (Array.isArray(payload?.flags)) {
        replaceFeatureFlags(payload.flags);
      } else if (payload?.flag) {
        upsertFeatureFlag(payload.flag);
      }
      state.featureFlags.error = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update feature flag";
      state.featureFlags.error = message;
      showToast?.(message, { variant: "error" });
    } finally {
      state.featureFlags.pending.delete(normalizedKey);
      render();
    }
  };

  const buildFeatureFlagsTable = (items) => {
    const tableWrapper = document.createElement("div");
    tableWrapper.className = "wm-feature-flags__table-wrapper";

    const table = document.createElement("table");
    table.className = "wm-feature-flags__table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["Flag", "Key", "Description", "State", "Visibility", "Updated"].forEach((heading) => {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = heading;
      headRow.append(th);
    });
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement("tbody");

    items.forEach((flag) => {
      const row = document.createElement("tr");
      row.className = "wm-feature-flags__row";

      const flagCell = document.createElement("td");
      flagCell.className = "wm-feature-flags__cell wm-feature-flags__cell--flag";
      flagCell.dataset.label = "Flag";
      const flagLabel = document.createElement("strong");
      flagLabel.textContent = flag.label;
      flagCell.append(flagLabel);

      const keyCell = document.createElement("td");
      keyCell.className = "wm-feature-flags__cell wm-feature-flags__cell--key";
      keyCell.dataset.label = "Key";
      const key = document.createElement("code");
      key.textContent = flag.key;
      keyCell.append(key);

      const descriptionCell = document.createElement("td");
      descriptionCell.className = "wm-feature-flags__cell wm-feature-flags__cell--description";
      descriptionCell.dataset.label = "Description";
      descriptionCell.textContent = flag.description || "—";

      const stateCell = document.createElement("td");
      stateCell.className = "wm-feature-flags__cell wm-feature-flags__cell--state";
      stateCell.dataset.label = "State";
      const select = document.createElement("select");
      FEATURE_FLAG_STATES.forEach((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = FEATURE_FLAG_STATE_LABELS[value] ?? value;
        select.append(option);
      });
      const currentState = normaliseFeatureFlagStateValue(flag.state) ?? "off";
      select.value = currentState;
      const pending = state.featureFlags.pending.has(flag.key) || state.featureFlags.loading;
      select.disabled = pending;
      select.addEventListener("change", (event) => {
        const nextValue = normaliseFeatureFlagStateValue(event.target.value) ?? currentState;
        if (nextValue === currentState) return;
        void updateFeatureFlagState(flag.key, nextValue);
      });
      stateCell.append(select);

      const effectiveCell = document.createElement("td");
      effectiveCell.className = "wm-feature-flags__cell wm-feature-flags__cell--visibility";
      effectiveCell.dataset.label = "Visibility";
      const resolved = resolveFeatureFlagForViewer(flag.key, { fallbackState: flag.state });
      effectiveCell.textContent = resolved.effectiveState === "on" ? "Visible to you" : "Hidden from you";

      const metaCell = document.createElement("td");
      metaCell.className = "wm-feature-flags__cell wm-feature-flags__cell--meta";
      metaCell.dataset.label = "Updated";
      const details = [];
      if (flag.updatedBy) {
        details.push(abbreviateNpub ? abbreviateNpub(flag.updatedBy) : flag.updatedBy);
      }
      if (flag.updatedAt) {
        details.push(new Date(flag.updatedAt).toLocaleString());
      }
      metaCell.textContent = details.length > 0 ? details.join(" • ") : "—";

      row.append(flagCell, keyCell, descriptionCell, stateCell, effectiveCell, metaCell);
      tbody.append(row);
    });

    table.append(tbody);
    tableWrapper.append(table);
    return tableWrapper;
  };

  const renderFeatureFlagsList = () => {
    const flagsState = state.featureFlags;
    if (flagsState.loading && !flagsState.initialized) {
      const loading = document.createElement("p");
      loading.className = "wm-feature-flags__empty";
      loading.textContent = "Loading feature flags…";
      return loading;
    }

    if (flagsState.error) {
      const errorBox = document.createElement("div");
      errorBox.className = "wm-feature-flags__error";
      const message = document.createElement("p");
      message.textContent = flagsState.error;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "wm-button secondary";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => {
        void fetchFeatureFlags();
      });
      errorBox.append(message, retry);
      const container = document.createElement("div");
      container.append(errorBox);
      const items = Array.isArray(flagsState.items) ? flagsState.items : [];
      if (items.length === 0) {
        return container;
      }
      const list = buildFeatureFlagsTable(items);
      container.append(list);
      return container;
    }

    const items = Array.isArray(flagsState.items) ? flagsState.items : [];
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-feature-flags__empty";
      empty.textContent = "No feature flags defined yet.";
      return empty;
    }

    return buildFeatureFlagsTable(items);
  };

  const renderFeatureFlagsPanel = () => {
    const { card, body } = createCollapsibleCard({
      title: "Feature Flags",
      className: "wm-feature-flags",
      collapsed: state.settingsPanels.featureFlagsCollapsed,
      onToggle(collapsed) {
        state.settingsPanels.featureFlagsCollapsed = collapsed;
      },
    });

    const intro = document.createElement("div");
    intro.className = "wm-feature-flags__header";

    const help = document.createElement("p");
    help.className = "wm-feature-flags__help";
    help.textContent = "Create and toggle admin-controlled feature flags. States can be Off, Admin only, or On for everyone. Click Add feature flag to open the creation modal.";

    const createButton = document.createElement("button");
    createButton.type = "button";
    createButton.className = "wm-button";
    createButton.textContent = "Add feature flag";
    createButton.addEventListener("click", () => {
      openDialog();
    });

    intro.append(help, createButton);
    body.append(intro);
    body.append(renderFeatureFlagsList());

    return card;
  };

  const createCollapsibleCard = ({ title, className = "", collapsed = false, onToggle } = {}) => {
    const card = document.createElement("section");
    card.className = ["wm-card", "wm-collapsible", className].filter(Boolean).join(" ");
    if (collapsed) {
      card.dataset.collapsed = "true";
    }

    const header = document.createElement("header");
    header.className = "wm-collapsible__header";

    const heading = document.createElement("h2");
    heading.textContent = title;
    header.append(heading);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "wm-collapsible__toggle";
    toggle.setAttribute("aria-label", collapsed ? "Expand section" : "Collapse section");
    toggle.textContent = collapsed ? "Show" : "Hide";
    toggle.addEventListener("click", () => {
      const next = card.dataset.collapsed === "true" ? false : true;
      if (next) {
        card.dataset.collapsed = "true";
        toggle.textContent = "Show";
        toggle.setAttribute("aria-label", "Expand section");
      } else {
        delete card.dataset.collapsed;
        toggle.textContent = "Hide";
        toggle.setAttribute("aria-label", "Collapse section");
      }
      onToggle?.(next);
    });
    header.append(toggle);
    card.append(header);

    const body = document.createElement("div");
    body.className = "wm-collapsible__body";
    if (collapsed) {
      body.hidden = true;
    }
    if (collapsed) {
      card.dataset.collapsed = "true";
    }
    card.append(body);

    return { card, body };
  };

  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitFeatureFlagCreate();
    });
  }
  cancelButton?.addEventListener("click", (event) => {
    event.preventDefault();
    closeDialog();
  });

  return {
    ensureLoaded: ensureFeatureFlagsLoaded,
    renderPanel: renderFeatureFlagsPanel,
    syncFromConfig: replaceFeatureFlags,
    resolveFlag: resolveFeatureFlagForViewer,
    isEnabled: isFeatureEnabledForViewer,
    projectsEnabled: projectsFeatureEnabledForViewer,
    openCreateDialog: openDialog,
  };
};
