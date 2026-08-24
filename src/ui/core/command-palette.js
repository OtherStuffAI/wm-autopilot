import { showRunningAppsModal } from "../apps/running-apps-modal.js";
import { showArchiveSessionsModal } from "../home/archive-modal.js";
import { openCommandFileBrowserModal } from "../modals/file-browser-modal.js";
import { showRunningPipelinesModal } from "../pipelines/running-pipelines-modal.js";
import { getSessionDisplayName } from "./icons.js";
import { launchProjectSession } from "./project-session-launcher.js";
import {
  escapeAttribute,
  escapeHtml,
  createCommandPaletteArchiveItem,
  createCommandItem,
  createCommandPaletteLaunchItems,
  createCommandPaletteQuickItems,
  filterCommandPaletteItems,
  getCommandPaletteKeyboardItems,
  getCommandPaletteSessionEntries,
  getNextCommandPaletteActiveId,
  rememberRecentItem,
} from "./command-palette-utils.js";

const RECENT_SESSION_STORAGE_KEY = "wingman:command-palette:recent-sessions";
const RECENT_APP_RESTART_STORAGE_KEY = "wingman:command-palette:recent-app-restarts";
const COMMAND_PALETTE_INPUT_SELECTOR = "[data-command-palette-input]";

function getItemElementId(itemId) {
  return `command-palette-item-${String(itemId ?? "").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function readStoredArray(key) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredArray(key, items) {
  try {
    window.localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // Storage can fail in private mode or when quota is exhausted.
  }
}

function normalizeStoredRecentApp(entry, apps) {
  const id = typeof entry?.id === "string" ? entry.id : "";
  if (!id) return null;
  const app = apps.find((candidate) => candidate?.id === id);
  if (!app) return null;
  return {
    id,
    title: app.label ?? app.id,
    subtitle: app.root ?? "Restart app",
  };
}

export function createAutopilotCommandPalette({
  brandButton,
  appsStore,
  sessionsStore,
  openDialog,
  openIdentityLoginDialog,
  isAuthenticated,
  state,
  launchSession,
  npubProjectsState,
  fetchNpubProjects,
  navigateHome,
  navigateToApps,
  getFileBrowserInitialPath,
  getFileBrowserSession,
  pinFileToSession,
  openSession,
  renderAppCard,
  refreshApps,
  triggerAppAction,
  resumeNativeSession,
  showToast,
}) {
  let overlay = null;
  let query = "";
  let activeId = "";
  let mode = "root";
  let launchProjectsLoading = false;

  function getQuickItems() {
    return createCommandPaletteQuickItems();
  }

  function getLaunchProjects() {
    return Array.isArray(npubProjectsState?.items) ? npubProjectsState.items : [];
  }

  function getLaunchItems() {
    return createCommandPaletteLaunchItems(getLaunchProjects());
  }

  function getRecentSessionItems() {
    const sessions = Array.isArray(sessionsStore?.().items) ? sessionsStore().items : [];
    const recentItems = getCommandPaletteSessionEntries(
      readStoredArray(RECENT_SESSION_STORAGE_KEY),
      sessions,
      getSessionDisplayName,
    )
      .map((entry) => createCommandItem({
        group: "recent-session",
        groupLabel: "Recent Sessions",
        id: `session:${entry.id}`,
        title: entry.title,
        subtitle: entry.subtitle,
        action: "open-session",
        targetId: entry.id,
        searchText: entry.id,
      }));
    return [...recentItems, createCommandPaletteArchiveItem()];
  }

  function getRecentAppItems() {
    const apps = Array.isArray(appsStore?.().items) ? appsStore().items : [];
    return readStoredArray(RECENT_APP_RESTART_STORAGE_KEY)
      .map((entry) => normalizeStoredRecentApp(entry, apps))
      .filter(Boolean)
      .map((entry) => createCommandItem({
        group: "recent-app",
        groupLabel: "Recent App Restarts",
        id: `app-restart:${entry.id}`,
        title: entry.title,
        subtitle: entry.subtitle,
        action: "restart-app",
        targetId: entry.id,
        searchText: entry.id,
      }));
  }

  function getItems() {
    if (mode === "session-launch") {
      return getLaunchItems();
    }
    return [...getQuickItems(), ...getRecentSessionItems(), ...getRecentAppItems()];
  }

  function getFilteredItems() {
    return filterCommandPaletteItems(getItems(), query);
  }

  function getGroupedItems(items) {
    const groups = [];
    for (const item of items) {
      let group = groups.find((entry) => entry.id === item.group);
      if (!group) {
        group = { id: item.group, label: item.groupLabel, items: [] };
        groups.push(group);
      }
      group.items.push(item);
    }
    return groups;
  }

  function recordSessionVisit(session) {
    const id = typeof session?.id === "string" ? session.id : "";
    if (!id) return;
    const items = rememberRecentItem(readStoredArray(RECENT_SESSION_STORAGE_KEY), {
      id,
      title: getSessionDisplayName(session),
      subtitle: session.workingDirectory ?? session.directory ?? "",
    });
    writeStoredArray(RECENT_SESSION_STORAGE_KEY, items);
  }

  function recordAppRestart(app) {
    const id = typeof app?.id === "string" ? app.id : "";
    if (!id) return;
    const items = rememberRecentItem(readStoredArray(RECENT_APP_RESTART_STORAGE_KEY), {
      id,
      title: app.label ?? app.id,
      subtitle: app.root ?? "",
    });
    writeStoredArray(RECENT_APP_RESTART_STORAGE_KEY, items);
  }

  function close() {
    overlay?.remove();
    overlay = null;
    query = "";
    activeId = "";
    mode = "root";
    launchProjectsLoading = false;
  }

  function open() {
    close();
    overlay = document.createElement("div");
    overlay.className = "wm-command-palette-overlay";
    overlay.dataset.testid = "autopilot-command-palette";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "autopilot-command-palette-title");
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    document.body.append(overlay);
    render();
    requestAnimationFrame(() => {
      overlay?.querySelector("[data-command-palette-input]")?.focus();
    });
  }

  function openSessionLaunch() {
    open();
    void enterSessionLaunchMode();
  }

  async function enterSessionLaunchMode() {
    if (!isAuthenticated?.()) {
      close();
      openIdentityLoginDialog?.();
      return;
    }

    mode = "session-launch";
    query = "";
    activeId = "";
    render();

    if (typeof fetchNpubProjects !== "function") {
      return;
    }

    launchProjectsLoading = true;
    render();
    try {
      await fetchNpubProjects();
    } catch {
      // The project store exposes its own error state; keep the launcher usable.
    } finally {
      launchProjectsLoading = false;
      render();
    }
  }

  async function launchProjectFromItem(item) {
    const project = getLaunchProjects().find((entry) => entry?.id === item?.targetId);
    close();
    const success = await launchProjectSession({
      project,
      state,
      launchSession,
      showToast,
    });
    if (!success && !project) {
      showToast?.("Project is no longer available.", { type: "error" });
    }
  }

  async function execute(item) {
    if (!item) return;
    if (item.action === "new-session") {
      await enterSessionLaunchMode();
      return;
    }
    close();
    if (item.action === "home") {
      navigateHome?.();
      return;
    }
    if (!isAuthenticated?.()) {
      openIdentityLoginDialog?.();
      return;
    }
    if (item.action === "open-session-modal") {
      openDialog?.();
      return;
    }
    if (item.action === "launch-project-session") {
      await launchProjectFromItem(item);
      return;
    }
    if (item.action === "archive-sessions") {
      showArchiveSessionsModal({
        resumeNativeSession,
        showToast,
      });
      return;
    }
    if (item.action === "running-apps") {
      showRunningAppsModal({
        appsStore,
        renderAppCard,
        refreshApps,
        triggerAppAction,
        openNewApp: () => navigateToApps?.({ openNewAppDialog: true }),
        showToast,
      });
      return;
    }
    if (item.action === "running-pipelines") {
      showRunningPipelinesModal({ showToast });
      return;
    }
    if (item.action === "files") {
      openCommandFileBrowserModal({
        initialPath: getFileBrowserInitialPath?.() ?? "",
        favourites: state?.files?.favourites ?? [],
        getSession: getFileBrowserSession,
        onPinFile: pinFileToSession,
        showToast,
      });
      return;
    }
    if (item.action === "open-session") {
      const session = sessionsStore?.().items?.find((entry) => entry?.id === item.targetId);
      if (session) {
        recordSessionVisit(session);
        openSession?.(session);
      }
      return;
    }
    if (item.action === "restart-app") {
      const app = appsStore?.().items?.find((entry) => entry?.id === item.targetId);
      const success = item.targetId && typeof triggerAppAction === "function"
        ? await triggerAppAction(item.targetId, "restart")
        : false;
      if (success) {
        recordAppRestart(app ?? { id: item.targetId, label: item.title, root: item.subtitle });
        showToast?.(`Restarting ${item.title}...`, { type: "success" });
      }
    }
  }

  function setActive(nextId) {
    activeId = nextId;
    syncActiveElement({ scroll: true });
  }

  function syncActiveElement({ scroll = false } = {}) {
    const activeElementId = activeId ? getItemElementId(activeId) : "";
    overlay?.querySelector(COMMAND_PALETTE_INPUT_SELECTOR)?.setAttribute(
      "aria-activedescendant",
      activeElementId,
    );
    overlay?.querySelectorAll("[data-command-palette-item]").forEach((button) => {
      const selected = button.dataset.itemId === activeId;
      button.classList.toggle("wm-command-palette-result-active", selected);
      button.setAttribute("aria-selected", selected ? "true" : "false");
      if (selected && scroll && typeof button.scrollIntoView === "function") {
        button.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function moveActive(delta) {
    const items = getCommandPaletteKeyboardItems(getFilteredItems());
    if (items.length === 0) return;
    setActive(getNextCommandPaletteActiveId(items, activeId, delta));
  }

  function getRenderModel() {
    const items = getFilteredItems();
    const keyboardItems = getCommandPaletteKeyboardItems(items);
    activeId = activeId && items.some((item) => item.id === activeId)
      ? activeId
      : keyboardItems[0]?.id ?? "";
    const groups = getGroupedItems(items);
    const placeholder = mode === "session-launch"
      ? "Choose a recent project or open the launch modal"
        : "Search sessions, apps, and commands";
    const shortcutLabel = mode === "session-launch" ? "0-9" : "Cmd K";
    const emptyMessage = mode === "session-launch" && launchProjectsLoading
      ? "Loading recent projects..."
      : "No commands match.";

    return {
      groups,
      placeholder,
      shortcutLabel,
      emptyMessage,
    };
  }

  function updateSearchInput(input, model, { syncValue = true } = {}) {
    if (!input) return;
    if (syncValue && input.value !== query) {
      input.value = query;
    }
    input.placeholder = model.placeholder;
    input.setAttribute("aria-activedescendant", activeId ? getItemElementId(activeId) : "");
  }

  function bindResultEvents() {
    overlay?.querySelectorAll("[data-command-palette-item]").forEach((button) => {
      button.addEventListener("mouseenter", () => setActive(button.dataset.itemId ?? ""));
      button.addEventListener("click", () => {
        const item = getFilteredItems().find((entry) => entry.id === button.dataset.itemId);
        void execute(item);
      });
    });
  }

  function renderResults(model) {
    const results = overlay?.querySelector("#autopilot-command-palette-results");
    if (!results) return;
    results.innerHTML = model.groups.length
      ? model.groups.map(renderGroup).join("")
      : `<p class="wm-command-palette-empty">${escapeHtml(model.emptyMessage)}</p>`;
    bindResultEvents();
  }

  function bindSearchInput(input) {
    input?.addEventListener("input", (event) => {
      query = event.target?.value ?? "";
      activeId = "";
      render({ syncInputValue: false });
    });
  }

  function render({ syncInputValue = true } = {}) {
    if (!overlay) return;
    const model = getRenderModel();
    let input = overlay.querySelector(COMMAND_PALETTE_INPUT_SELECTOR);

    if (!input) {
      overlay.innerHTML = `
        <section class="wm-command-palette" aria-labelledby="autopilot-command-palette-title">
          <h2 id="autopilot-command-palette-title" class="wm-sr-only">Command palette</h2>
          <div class="wm-command-palette-search">
            <input
              type="search"
              value="${escapeAttribute(query)}"
              placeholder="${escapeAttribute(model.placeholder)}"
              data-command-palette-input
              aria-label="Search commands"
              aria-controls="autopilot-command-palette-results"
              aria-activedescendant="${escapeAttribute(activeId ? getItemElementId(activeId) : "")}"
              autocomplete="off"
            />
            <kbd data-command-palette-shortcut>${escapeHtml(model.shortcutLabel)}</kbd>
          </div>
          <div id="autopilot-command-palette-results" class="wm-command-palette-results" role="listbox" aria-label="Command results"></div>
        </section>
      `;
      input = overlay.querySelector(COMMAND_PALETTE_INPUT_SELECTOR);
      bindSearchInput(input);
    } else {
      const shortcut = overlay.querySelector("[data-command-palette-shortcut]");
      if (shortcut) {
        shortcut.textContent = model.shortcutLabel;
      }
    }

    updateSearchInput(input, model, { syncValue: syncInputValue });
    renderResults(model);
    syncActiveElement();
  }

  function renderGroup(group) {
    const quickClass = group.id === "shortcut" ? " wm-command-palette-group-quick" : "";
    const launchClass = group.id === "session-launch" ? " wm-command-palette-group-launch" : "";
    return `
      <section class="wm-command-palette-group${quickClass}${launchClass}">
        <h3>${escapeHtml(group.label)}</h3>
        <div class="wm-command-palette-group-items">
          ${group.items.map(renderItem).join("")}
        </div>
      </section>
    `;
  }

  function renderItem(item) {
    const isActive = item.id === activeId;
    return `
      <button
        type="button"
        id="${escapeAttribute(getItemElementId(item.id))}"
        class="wm-command-palette-result${isActive ? " wm-command-palette-result-active" : ""}"
        data-command-palette-item
        data-item-id="${escapeAttribute(item.id)}"
        role="option"
        aria-selected="${isActive ? "true" : "false"}"
      >
        <span class="wm-command-palette-result-key">${item.shortcutKey ? escapeHtml(item.shortcutKey) : ""}</span>
        <span class="wm-command-palette-result-main">
          <span class="wm-command-palette-result-title">${escapeHtml(item.title)}</span>
          <span class="wm-command-palette-result-subtitle">${escapeHtml(item.subtitle)}</span>
        </span>
        <span class="wm-command-palette-result-type">${escapeHtml(item.groupLabel)}</span>
      </button>
    `;
  }

  function handleKeydown(event) {
    const key = String(event.key || "").toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === "k") {
      event.preventDefault();
      open();
      return;
    }
    if (!overlay) return;
    if (key === "escape") {
      event.preventDefault();
      close();
      return;
    }
    if (key === "arrowdown") {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (key === "arrowup") {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (key === "enter") {
      event.preventDefault();
      const item = getFilteredItems().find((entry) => entry.id === activeId);
      void execute(item);
      return;
    }
    if (mode === "session-launch" && !query && /^[0-9]$/.test(key)) {
      event.preventDefault();
      const item = getLaunchItems().find((entry) => entry.shortcutKey === key);
      void execute(item);
      return;
    }
    if (!query && /^[0-4]$/.test(key)) {
      event.preventDefault();
      const item = getQuickItems().find((entry) => entry.shortcutKey === key);
      void execute(item);
    }
  }

  brandButton?.addEventListener("click", (event) => {
    event.preventDefault();
    open();
  });
  window.addEventListener("keydown", handleKeydown, true);

  return {
    open,
    openSessionLaunch,
    close,
    recordSessionVisit,
    recordAppRestart,
  };
}
