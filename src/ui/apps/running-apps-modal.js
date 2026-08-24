import { getAppDisplayName, getAppOpenUrl, getAppStatusValue } from "./table.js";

const APP_BUSY_STATUSES = new Set(["stopping", "restarting", "building", "setting-up"]);

export function isRunningApp(app) {
  return getAppStatusValue(app) === "running";
}

export function getModalApps(apps) {
  return Array.isArray(apps)
    ? apps.filter((app) => app?.id !== "wingman-core")
    : [];
}

export function getRunningApps(apps) {
  return getModalApps(apps).filter((app) => isRunningApp(app));
}

export function getAlphabeticalApps(apps) {
  return getModalApps(apps).sort((left, right) => getAppDisplayName(left).localeCompare(
    getAppDisplayName(right),
    undefined,
    { numeric: true, sensitivity: "base" },
  ));
}

export function getAppListAction(app) {
  if (isRunningApp(app) && app?.availableScripts?.restart) {
    return "restart";
  }
  if (!isRunningApp(app) && app?.availableScripts?.start) {
    return "start";
  }
  if (!isRunningApp(app) && app?.availableScripts?.restart) {
    return "restart";
  }
  return null;
}

export function showRunningAppsModal({
  appsStore,
  renderAppCard,
  refreshApps,
  triggerAppAction,
  openNewApp,
  showToast,
}) {
  const existing = document.getElementById("running-apps-modal");
  if (typeof HTMLDialogElement === "function" && existing instanceof HTMLDialogElement && existing.open) {
    existing.close();
    existing.remove();
  } else {
    existing?.remove();
  }

  const dialog = document.createElement("dialog");
  dialog.id = "running-apps-modal";
  dialog.className = "wm-running-apps-modal";
  dialog.dataset.testid = "running-apps-modal";
  dialog.setAttribute("aria-labelledby", "running-apps-modal-title");

  const shell = document.createElement("div");
  shell.className = "wm-running-apps-modal__shell";

  const header = document.createElement("header");
  header.className = "wm-running-apps-modal__header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "wm-running-apps-modal__title";
  const title = document.createElement("h2");
  title.id = "running-apps-modal-title";
  title.textContent = "Running Apps";
  const subtitle = document.createElement("p");
  subtitle.setAttribute("aria-live", "polite");
  titleWrap.append(title, subtitle);

  const headerActions = document.createElement("div");
  headerActions.className = "wm-running-apps-modal__header-actions";

  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "wm-button secondary wm-button--small";
  refreshButton.textContent = "Refresh";
  refreshButton.dataset.testid = "running-apps-modal-refresh";

  const newAppButton = document.createElement("button");
  newAppButton.type = "button";
  newAppButton.className = "wm-button wm-button--small";
  newAppButton.textContent = "New App";
  newAppButton.dataset.testid = "running-apps-modal-new-app";
  newAppButton.setAttribute("aria-label", "Create a new app");
  newAppButton.addEventListener("click", () => {
    dialog.close();
    if (typeof openNewApp === "function") {
      openNewApp();
    }
  });

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "wm-button secondary wm-button--small";
  closeButton.textContent = "Close";
  closeButton.setAttribute("aria-label", "Close running apps");
  closeButton.dataset.testid = "running-apps-modal-close";
  closeButton.addEventListener("click", () => dialog.close());

  headerActions.append(newAppButton, refreshButton, closeButton);
  header.append(titleWrap, headerActions);

  const body = document.createElement("div");
  body.className = "wm-running-apps-modal__body";

  const status = document.createElement("p");
  status.className = "wm-running-apps-modal__status";
  status.setAttribute("aria-live", "polite");

  shell.append(header, body, status);
  dialog.append(shell);

  let selectedAppId = null;
  let loading = false;
  let showAllApps = false;

  function setStatus(message, type = "") {
    status.textContent = message ?? "";
    status.dataset.state = type;
  }

  function getStoreApps() {
    const appState = typeof appsStore === "function" ? appsStore() : null;
    return Array.isArray(appState?.items) ? appState.items : [];
  }

  function findSelectedApp() {
    if (!selectedAppId) return null;
    return getStoreApps().find((app) => app?.id === selectedAppId) ?? null;
  }

  function renderAppStatusBadge(app) {
    const badge = document.createElement("span");
    badge.className = "wm-app-status";
    const statusValue = getAppStatusValue(app);
    badge.dataset.state = statusValue;
    badge.textContent = statusValue;
    return badge;
  }

  function renderOpenLink(app) {
    const openUrl = getAppOpenUrl(app);
    if (!openUrl) return null;
    const link = document.createElement("a");
    link.className = "wm-running-apps-modal__open-link";
    link.href = openUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open";
    link.setAttribute("aria-label", `Open ${getAppDisplayName(app)}`);
    return link;
  }

  async function refreshModalApps() {
    if (loading) return;
    loading = true;
    refreshButton.disabled = true;
    refreshButton.textContent = "Refreshing...";
    setStatus("Refreshing apps...");
    renderContent();
    try {
      if (typeof refreshApps === "function") {
        await refreshApps({ skipRender: true });
      } else {
        const appState = typeof appsStore === "function" ? appsStore() : null;
        if (typeof appState?.sync === "function") {
          await appState.sync();
        }
      }
      setStatus("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to refresh apps.";
      setStatus(message, "error");
      showToast?.(message, { type: "error" });
    } finally {
      loading = false;
      refreshButton.disabled = false;
      refreshButton.textContent = "Refresh";
      renderContent();
    }
  }

  function isAppActionDisabled(app, action) {
    if (!app?.id || !action || !app?.availableScripts?.[action]) return true;
    if (app.status?.inProgressAction) return true;
    const statusValue = getAppStatusValue(app);
    if (APP_BUSY_STATUSES.has(statusValue)) return true;
    if (action === "start") return statusValue === "running";
    return false;
  }

  async function runAppAction(app, action, button) {
    if (!app?.id || !action || button.disabled) return;
    const actionLabel = action === "start" ? "Start" : "Restart";
    const actionVerb = action === "start" ? "Starting" : "Restarting";
    button.disabled = true;
    button.textContent = `${actionVerb}...`;
    setStatus(`${actionVerb} ${getAppDisplayName(app)}...`);
    try {
      const success = typeof triggerAppAction === "function"
        ? await triggerAppAction(app.id, action)
        : false;
      if (success) {
        showToast?.(`${actionVerb} ${getAppDisplayName(app)}...`, { type: "success" });
        await refreshModalApps();
      } else if (button.isConnected) {
        button.disabled = false;
        button.textContent = actionLabel;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to ${action} app.`;
      setStatus(message, "error");
      showToast?.(message, { type: "error" });
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = actionLabel;
      }
    }
  }

  function renderAppActionButton(app, action) {
    if (!action) return null;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wm-button secondary wm-button--small";
    button.textContent = action === "start" ? "Start" : "Restart";
    button.disabled = isAppActionDisabled(app, action);
    button.dataset.testid = action === "start" ? "running-app-start" : "running-app-restart";
    button.setAttribute("aria-label", `${button.textContent} ${getAppDisplayName(app)}`);
    button.addEventListener("click", () => void runAppAction(app, action, button));
    return button;
  }

  function renderAppListItem(app, { allowStart = false } = {}) {
    const item = document.createElement("article");
    item.className = "wm-running-apps-list__item";
    item.dataset.appId = String(app.id ?? "");

    const mainButton = document.createElement("button");
    mainButton.type = "button";
    mainButton.className = "wm-running-apps-list__main";
    mainButton.dataset.testid = "running-app-details";
    mainButton.setAttribute("aria-label", `Show details for ${getAppDisplayName(app)}`);
    mainButton.addEventListener("click", () => {
      selectedAppId = app.id;
      renderContent();
    });

    const name = document.createElement("span");
    name.className = "wm-running-apps-list__name";
    name.textContent = getAppDisplayName(app);

    const root = document.createElement("code");
    root.className = "wm-running-apps-list__root";
    root.textContent = app.root ?? "";
    root.title = app.root ?? "";

    mainButton.append(name, root);

    const actions = document.createElement("div");
    actions.className = "wm-running-apps-list__actions";
    actions.append(renderAppStatusBadge(app));

    const openLink = renderOpenLink(app);
    if (openLink) {
      actions.append(openLink);
    }

    const appAction = allowStart ? getAppListAction(app) : (app.availableScripts?.restart ? "restart" : null);
    const actionButton = renderAppActionButton(app, appAction);
    if (actionButton) {
      actions.append(actionButton);
    }

    item.append(mainButton, actions);
    return item;
  }

  function renderStartAppToggle(totalApps) {
    if (totalApps === 0) return;
    const footer = document.createElement("div");
    footer.className = "wm-running-apps-modal__list-footer";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "wm-button";
    button.textContent = showAllApps ? "Hide App List" : "Start an App";
    button.dataset.testid = "running-apps-start-app-toggle";
    button.setAttribute("aria-label", showAllApps ? "Hide full app list" : "Show full app list to start an app");
    button.setAttribute("aria-expanded", showAllApps ? "true" : "false");
    button.addEventListener("click", () => {
      showAllApps = !showAllApps;
      renderContent();
    });

    footer.append(button);
    body.append(footer);
  }

  function renderAllAppsList(allApps) {
    if (!showAllApps) return;

    const section = document.createElement("section");
    section.className = "wm-running-apps-modal__all-apps";
    section.setAttribute("aria-labelledby", "running-apps-all-apps-title");
    section.dataset.testid = "running-apps-all-apps";

    const heading = document.createElement("h3");
    heading.id = "running-apps-all-apps-title";
    heading.textContent = "All Apps";
    section.append(heading);

    if (allApps.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-running-apps-modal__empty";
      empty.textContent = "No apps are registered.";
      section.append(empty);
      body.append(section);
      return;
    }

    const list = document.createElement("div");
    list.className = "wm-running-apps-list";
    allApps.forEach((app) => {
      list.append(renderAppListItem(app, { allowStart: true }));
    });
    section.append(list);
    body.append(section);
  }

  function renderListView() {
    const allApps = getAlphabeticalApps(getStoreApps());
    const runningApps = getRunningApps(getStoreApps());
    subtitle.textContent = loading
      ? "Refreshing..."
      : showAllApps
        ? `${runningApps.length} running, ${allApps.length} total`
        : `${runningApps.length} running app${runningApps.length === 1 ? "" : "s"}`;

    if (loading && runningApps.length === 0) {
      const loadingEl = document.createElement("p");
      loadingEl.className = "wm-running-apps-modal__empty";
      loadingEl.textContent = "Loading apps...";
      body.append(loadingEl);
      renderStartAppToggle(allApps.length);
      return;
    }

    if (runningApps.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-running-apps-modal__empty";
      empty.textContent = "No apps are currently running.";
      body.append(empty);
    } else {
      const list = document.createElement("div");
      list.className = "wm-running-apps-list";
      list.dataset.testid = "running-apps-list";
      runningApps.forEach((app) => {
        list.append(renderAppListItem(app));
      });
      body.append(list);
    }

    renderStartAppToggle(allApps.length);
    renderAllAppsList(allApps);
  }

  function renderDetailsView(app) {
    subtitle.textContent = getAppDisplayName(app);

    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.className = "wm-button secondary wm-button--small wm-running-apps-modal__back";
    backButton.textContent = "Back to apps";
    backButton.dataset.testid = "running-apps-back";
    backButton.addEventListener("click", () => {
      selectedAppId = null;
      renderContent();
    });
    body.append(backButton);

    if (typeof renderAppCard !== "function") {
      const unavailable = document.createElement("p");
      unavailable.className = "wm-running-apps-modal__empty";
      unavailable.textContent = "App details are unavailable.";
      body.append(unavailable);
      return;
    }

    const card = renderAppCard(app);
    if (card instanceof HTMLElement) {
      card.classList.add("wm-app-card--modal");
      body.append(card);
    }
  }

  function renderContent() {
    body.innerHTML = "";
    const selectedApp = findSelectedApp();
    if (selectedApp) {
      renderDetailsView(selectedApp);
      return;
    }
    selectedAppId = null;
    renderListView();
  }

  refreshButton.addEventListener("click", () => void refreshModalApps());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
  });

  document.body.append(dialog);
  renderContent();
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else if (typeof dialog.show === "function") {
    dialog.show();
  } else {
    dialog.setAttribute("open", "open");
  }

  void refreshModalApps();
}
