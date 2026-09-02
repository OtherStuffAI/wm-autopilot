import { showAppCardModal } from "../apps/card-modal.js";
import { renderAppsListGroups } from "../apps/list-groups.js";
import { filterAndSortApps, renderAppsTable } from "../apps/table.js";

export const APPS_FILTER_FOCUS_KEY = "apps-filter-input";

export function shouldHoldAppListForFreshSnapshot(appState) {
  return !appState?.hasFreshSnapshot;
}

export function selectAppCardRenderer(app, renderAppCard, renderWingmanCard = renderAppCard) {
  return app?.id === "wingman-core" ? renderWingmanCard : renderAppCard;
}

export function buildAppFilterOptions({
  isAdmin,
  viewerNpub,
  filterOptions,
  abbreviateNpub,
}) {
  if (!isAdmin) {
    return [];
  }

  const seen = new Set();
  const options = [];

  function appendOption(value, label) {
    if (seen.has(value)) return;
    seen.add(value);
    options.push({ value, label });
  }

  if (viewerNpub) {
    appendOption(viewerNpub, `My apps (${abbreviateNpub(viewerNpub)})`);
  }
  appendOption("all", "All apps");

  for (const option of filterOptions) {
    if (!option || typeof option !== "object") continue;
    const value = typeof option.value === "string" ? option.value : "__anonymous__";
    if (seen.has(value)) continue;
    const alias = typeof option.alias === "string" && option.alias.trim().length > 0 ? option.alias.trim() : null;
    const npub = typeof option.npub === "string" ? option.npub : null;
    const appCount = typeof option.appCount === "number" ? option.appCount : 0;
    const baseLabel = alias ?? (npub ? abbreviateNpub(npub) : value === "__anonymous__" ? "Shared" : "Unknown");
    const detail = appCount === 0 ? "No apps" : appCount === 1 ? "1 app" : `${appCount} apps`;
    appendOption(value, `${baseLabel} • ${detail}`);
  }

  return options;
}

export function initAppsView({
  state,
  appsStore,
  getCurrentRoute,
  render,
  openAppDialog,
  renderAppCard,
  renderWingmanCard = renderAppCard,
  refreshApps,
  fetchApps,
  logPreviewLines,
  appStatusLabels,
  formatAppTimestamp,
  normaliseNpubValue,
  abbreviateNpub,
}) {
  function schedulePendingAppDialog() {
    if (appsStore().pendingOpenDialog === "create") {
      appsStore().pendingOpenDialog = null;
      requestAnimationFrame(() => {
        openAppDialog();
      });
    }
  }

  function focusPendingApp(container) {
    if (!appsStore().pendingFocusId) {
      return;
    }
    const targetId = appsStore().pendingFocusId;
    appsStore().pendingFocusId = null;
    requestAnimationFrame(() => {
      const escape =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape
          : (value) => value.replace(/"/g, '\\"');
      const selector = `[data-app-id="${escape(targetId)}"]`;
      const candidates = Array.from(container.querySelectorAll(selector));
      const target =
        candidates.find((candidate) => candidate instanceof HTMLElement && candidate.offsetParent !== null) ??
        candidates[0];
      if (!target) {
        return;
      }
      target.classList.add("wm-app-card--highlight");
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      window.setTimeout(() => {
        if (target.isConnected) {
          target.classList.remove("wm-app-card--highlight");
        }
      }, 1600);
    });
  }

  function renderAppsViewToggle(viewMode) {
    const toggle = document.createElement("div");
    toggle.className = "wm-apps-view-toggle";
    toggle.setAttribute("role", "group");
    toggle.setAttribute("aria-label", "Apps view");

    [
      { mode: "table", label: "Table" },
      { mode: "cards", label: "Cards" },
    ].forEach((option) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = option.label;
      button.setAttribute("aria-pressed", viewMode === option.mode ? "true" : "false");
      button.dataset.testid = `apps-view-${option.mode}`;
      button.addEventListener("click", () => {
        const appState = appsStore();
        appState.viewMode = option.mode;
        render();
      });
      toggle.append(button);
    });

    return toggle;
  }

  function renderAppsFilterControl({ totalCount, visibleCount }) {
    const filterWrap = document.createElement("div");
    filterWrap.className = "wm-apps-filter";

    const label = document.createElement("label");
    label.className = "wm-apps-filter__label";
    label.setAttribute("for", "apps-filter-input");
    label.textContent = "Filter apps";

    const input = document.createElement("input");
    input.id = "apps-filter-input";
    input.className = "wm-apps-filter__input";
    input.type = "search";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "Name, port, or description";
    input.value = appsStore().filterText ?? "";
    input.setAttribute("aria-label", "Filter apps by name, port, or description");
    input.dataset.focusKey = APPS_FILTER_FOCUS_KEY;
    input.dataset.testid = "apps-filter-input";
    input.addEventListener("input", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      const cursor = target.selectionStart ?? target.value.length;
      appsStore().filterText = target.value;
      render();
      requestAnimationFrame(() => {
        const nextInput = document.getElementById("apps-filter-input");
        if (!(nextInput instanceof HTMLInputElement)) return;
        nextInput.focus();
        nextInput.setSelectionRange(cursor, cursor);
      });
    });

    const meta = document.createElement("span");
    meta.className = "wm-apps-filter__meta";
    meta.setAttribute("aria-live", "polite");
    meta.textContent = `${visibleCount} of ${totalCount}`;

    filterWrap.append(label, input, meta);
    return filterWrap;
  }

  function renderAppsCardGrid(apps, groupId) {
    const grid = document.createElement("div");
    grid.className = "wm-apps-grid";
    grid.dataset.testid = `apps-${groupId}-card-view`;

    apps.forEach((app) => {
      grid.append(selectAppCardRenderer(app, renderAppCard, renderWingmanCard)(app));
    });

    return grid;
  }

  function renderApps() {
    const wrapper = document.createElement("div");
    wrapper.className = "wm-apps";
    const viewMode = appsStore().viewMode === "cards" ? "cards" : "table";
    wrapper.dataset.viewMode = viewMode;

    const header = document.createElement("div");
    header.className = "wm-apps-header";

    const title = document.createElement("h2");
    title.textContent = "Apps";
    header.append(title);

    const headerActions = document.createElement("div");
    headerActions.className = "wm-apps-header-actions";

    if (state.identity.isAdmin) {
      const ownerFilterOptions = buildAppFilterOptions({
        isAdmin: true,
        viewerNpub: normaliseNpubValue(state.identity.npub),
        filterOptions: appsStore().filters.options,
        abbreviateNpub,
      });
      if (ownerFilterOptions.length > 0) {
        const filterContainer = document.createElement("div");
        filterContainer.className = "wm-session-filter";
        const filterLabel = document.createElement("label");
        filterLabel.textContent = "Owner";
        const filterSelect = document.createElement("select");
        filterSelect.className = "wm-select";
        ownerFilterOptions.forEach((option) => {
          const opt = document.createElement("option");
          opt.value = option.value;
          opt.textContent = option.label;
          const currentAppFilter = appsStore().filters.npub;
          if (option.value === currentAppFilter) {
            opt.selected = true;
          }
          filterSelect.append(opt);
        });
        filterSelect.addEventListener("change", (event) => {
          const target = event.target;
          const value = target instanceof HTMLSelectElement && target.value ? target.value : "all";
          const appState = appsStore();
          appState.filters.npub = value;
          appState.filters.initialized = true;
          void fetchApps({ tail: logPreviewLines }).then(() => {
            if (getCurrentRoute() === "apps" || getCurrentRoute() === "home") {
              render();
            }
          });
        });
        filterLabel.append(filterSelect);
        filterContainer.append(filterLabel);
        headerActions.append(filterContainer);
      }
    }

    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "wm-button secondary";
    refreshButton.textContent = appsStore().loading ? "Refreshing…" : "Refresh";
    refreshButton.disabled = appsStore().loading;
    refreshButton.addEventListener("click", () => {
      refreshButton.disabled = true;
      void refreshApps({ skipRender: false });
    });

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "wm-button";
    addButton.textContent = "Add App";
    addButton.addEventListener("click", () => openAppDialog());

    headerActions.append(renderAppsViewToggle(viewMode), refreshButton, addButton);
    header.append(headerActions);
    wrapper.append(header);

    if (!appsStore().initialized && !appsStore().loading) {
      void refreshApps({ skipRender: false });
    }

    const mainArea = document.createElement("div");
    mainArea.className = "wm-apps-main";
    const finishMainArea = () => {
      wrapper.append(mainArea);
      schedulePendingAppDialog();
      return wrapper;
    };

    if (appsStore().error) {
      const errorBox = document.createElement("div");
      errorBox.className = "wm-apps-error";
      const errorText = document.createElement("p");
      errorText.textContent = appsStore().error;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "wm-button secondary";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => {
        void refreshApps({ skipRender: false });
      });
      errorBox.append(errorText, retry);
      mainArea.append(errorBox);
    }

    if (shouldHoldAppListForFreshSnapshot(appsStore())) {
      const refreshing = document.createElement("p");
      refreshing.className = "wm-apps-empty";
      refreshing.setAttribute("role", "status");
      refreshing.setAttribute("aria-live", "polite");
      refreshing.dataset.testid = "apps-fresh-snapshot-status";
      refreshing.textContent = "Refreshing app status before enabling controls…";
      mainArea.append(refreshing);
      return finishMainArea();
    }

    const apps = Array.isArray(appsStore().items) ? appsStore().items : [];
    if (appsStore().loading && apps.length === 0) {
      const loading = document.createElement("p");
      loading.className = "wm-apps-empty";
      loading.textContent = "Loading apps…";
      mainArea.append(loading);
      return finishMainArea();
    }

    if (apps.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-apps-empty";
      empty.textContent = "No apps registered yet. Use 'Add App' to get started.";
      mainArea.append(empty);
      return finishMainArea();
    }

    const sort = appsStore().sort && typeof appsStore().sort === "object"
      ? appsStore().sort
      : { key: "title", direction: "asc" };
    const visibleApps = filterAndSortApps(apps, appsStore().filterText, sort);
    mainArea.append(renderAppsFilterControl({
      totalCount: apps.length,
      visibleCount: visibleApps.length,
    }));

    if (visibleApps.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-apps-empty";
      empty.textContent = "No apps match the current filter.";
      mainArea.append(empty);
      return finishMainArea();
    }

    const openAppDetails = (app) => {
      showAppCardModal({
        app,
        renderAppCard: selectAppCardRenderer(app, renderAppCard, renderWingmanCard),
      });
    };
    const renderTable = (groupApps, groupId) => {
      const table = renderAppsTable({
        apps: groupApps,
        appStatusLabels,
        formatAppTimestamp,
        onOpenAppDetails: openAppDetails,
        sort,
        onSortChange: (nextSort) => {
          appsStore().sort = nextSort;
          render();
        },
      });
      table.dataset.testid = `apps-${groupId}-table-view`;
      return table;
    };

    mainArea.append(renderAppsListGroups({
      apps: visibleApps,
      renderTable,
      renderCards: renderAppsCardGrid,
    }));
    wrapper.append(mainArea);

    focusPendingApp(wrapper);
    schedulePendingAppDialog();

    return wrapper;
  }

  return {
    renderApps,
  };
}
