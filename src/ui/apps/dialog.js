import { fetchStarterProjectsApi, launchStarterProjectApi } from "../services/starter-projects.js";
import { openConfirmDialog } from "../common/dialog-prompts.js";
import { formatLifecycleCommand, parseLifecycleCommand } from "./lifecycle-command.js";

export const initAppDialogs = ({
  state,
  getCurrentRoute,
  render,
  refreshApps,
  getAppById,
  openDirectoryBrowser,
  formatWebAppUrl,
  linkAppToProject,
  deriveAppWindowName,
  sharedTmuxSession,
  showToast,
}) => {
  const appDialog = document.getElementById("app-dialog");
  const appForm = appDialog?.querySelector("form") ?? null;
  const appDialogTitle = document.getElementById("app-dialog-title");
  const appLabelInput = document.getElementById("app-label");
  const appRootInput = document.getElementById("app-root");
  const appRootBrowseButton = document.getElementById("app-root-browse");
  const appAdvancedSection = document.getElementById("app-advanced");
  const appTmuxInput = document.getElementById("app-tmux-session");
  const appTmuxWindowInput = document.getElementById("app-tmux-window");
  const appTmuxSessionLabel = document.getElementById("app-tmux-session-label");
  const appTmuxSessionNote = document.getElementById("app-tmux-session-note");
  const appTmuxWindowLabel = document.getElementById("app-tmux-window-label");
  const appNotesInput = document.getElementById("app-notes");
  const appDiscoverToggle = document.getElementById("app-discover-enabled");
  const appDiscoverButton = document.getElementById("app-discover");
  const appWebAppToggle = document.getElementById("app-web-app");
  const appWebAppPortNote = document.getElementById("app-web-app-port");
  const appAutoStartToggle = document.getElementById("app-auto-start");
  const appEnvList = document.getElementById("app-env-list");
  const appEnvAddButton = document.getElementById("app-env-add");
  const appScriptInputs = {
    start: document.getElementById("app-script-start"),
    stop: document.getElementById("app-script-stop"),
    restart: document.getElementById("app-script-restart"),
    build: document.getElementById("app-script-build"),
    setup: document.getElementById("app-script-setup"),
  };
  const appLogsDialog = document.getElementById("app-logs-dialog");
  const appLogsTitle = document.getElementById("app-logs-title");
  const appLogsContent = document.getElementById("app-logs-content");
  const appLogsRefreshButton = document.getElementById("app-logs-refresh");
  const appLogsClearButton = document.getElementById("app-logs-clear");
  const appLogsCloseButton = document.getElementById("app-logs-close");
  const appCancelButton = document.getElementById("app-cancel");
  const appCloneButton = document.getElementById("app-clone");
  const appCloneDialog = document.getElementById("app-clone-dialog");
  const appCloneForm = appCloneDialog?.querySelector("form") ?? null;
  const appCloneUrlInput = document.getElementById("app-clone-url");
  const appCloneNameInput = document.getElementById("app-clone-name");
  const appCloneCancelButton = document.getElementById("app-clone-cancel");
  const appCloneConfirmButton = document.getElementById("app-clone-confirm");
  const appNewModeDialog = document.getElementById("app-new-mode-dialog");
  const appNewModeQuickButton = document.getElementById("app-new-mode-quick");
  const appNewModeManualButton = document.getElementById("app-new-mode-manual");
  const appNewModeCancelButton = document.getElementById("app-new-mode-cancel");
  const appStarterDialog = document.getElementById("app-starter-dialog");
  const appStarterForm = appStarterDialog?.querySelector("form") ?? null;
  const appStarterList = document.getElementById("app-starter-list");
  const appStarterNameInput = document.getElementById("app-starter-name");
  const appStarterGitHubOwnerInput = document.getElementById("app-starter-github-owner");
  const appStarterGitHubRepoInput = document.getElementById("app-starter-github-repo");
  const appStarterPrivateInput = document.getElementById("app-starter-private");
  const appStarterProtectInput = document.getElementById("app-starter-protect");
  const appStarterNotes = document.getElementById("app-starter-notes");
  const appStarterCancelButton = document.getElementById("app-starter-cancel");
  const appStarterConfirmButton = document.getElementById("app-starter-confirm");

  const appDialogState = {
    mode: "create",
    appId: null,
    webAppEnabled: false,
    webAppPort: null,
    projectContext: null,
  };
  const starterDialogState = {
    loading: false,
    launching: false,
    projects: [],
    selectedId: null,
  };

  const shouldShowAdvancedSection = () => Boolean(state.identity.isAdmin) || appDialogState.mode === "edit";

  const syncAppAdvancedVisibility = () => {
    if (!appAdvancedSection) return;
    const visible = shouldShowAdvancedSection();
    appAdvancedSection.hidden = !visible;
    if (!visible) {
      appAdvancedSection.open = false;
    }
  };

  const syncTmuxVisibility = () => {
    const isAdmin = Boolean(state.identity.isAdmin);
    const targets = [
      appTmuxSessionLabel,
      appTmuxInput,
      appTmuxSessionNote,
      appTmuxWindowLabel,
      appTmuxWindowInput,
    ];
    targets.forEach((element) => {
      if (!element) return;
      element.hidden = !isAdmin;
    });
  };

  syncAppAdvancedVisibility();
  syncTmuxVisibility();

  const deriveRepositoryFolderName = (input) => {
    if (!input) return "";
    const trimmed = input.trim();
    if (!trimmed) return "";
    const normalized = trimmed.replace(/\\+/g, "/");
    const parts = normalized.split(/[/:]/).filter(Boolean);
    if (parts.length === 0) return "";
    const candidate = parts[parts.length - 1].replace(/\.git$/i, "");
    return candidate;
  };

  const humaniseFolderLabel = (value) => {
    if (!value) return "";
    const spaced = value.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    if (!spaced) return "";
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  };

  const slugifyGitHubRepoName = (value) => {
    const slug = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[._-]+|[._-]+$/g, "");
    return slug || "";
  };

  const syncStarterRepoName = () => {
    if (!appStarterGitHubRepoInput || appStarterGitHubRepoInput.dataset.locked === "true") return;
    appStarterGitHubRepoInput.value = slugifyGitHubRepoName(appStarterNameInput?.value || "");
  };

  const getSelectedStarterProject = () => {
    if (!starterDialogState.selectedId) return null;
    return starterDialogState.projects.find((item) => item?.id === starterDialogState.selectedId) ?? null;
  };

  const setStarterDialogSubmitting = (submitting) => {
    starterDialogState.launching = submitting;
    if (appStarterConfirmButton) {
      appStarterConfirmButton.disabled = submitting || !starterDialogState.selectedId;
      appStarterConfirmButton.textContent = submitting ? "Creating..." : "Create App";
    }
    if (appStarterNameInput) {
      appStarterNameInput.disabled = submitting;
    }
    if (appStarterGitHubOwnerInput) appStarterGitHubOwnerInput.disabled = submitting;
    if (appStarterGitHubRepoInput) appStarterGitHubRepoInput.disabled = submitting;
    if (appStarterPrivateInput) appStarterPrivateInput.disabled = submitting;
    if (appStarterProtectInput) appStarterProtectInput.disabled = submitting;
  };

  const renderStarterProjectButtons = () => {
    if (!appStarterList) return;
    while (appStarterList.firstChild) {
      appStarterList.firstChild.remove();
    }
    if (starterDialogState.loading) {
      const loading = document.createElement("p");
      loading.className = "wm-field-note";
      loading.textContent = "Loading starter projects...";
      appStarterList.append(loading);
      return;
    }
    if (!Array.isArray(starterDialogState.projects) || starterDialogState.projects.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-field-note";
      empty.textContent = "No quick starters are configured yet.";
      appStarterList.append(empty);
      return;
    }
    starterDialogState.projects.forEach((project) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wm-button secondary wm-starter-grid__item";
      if (project?.id === starterDialogState.selectedId) {
        button.classList.add("is-active");
      }
      button.textContent = project?.name ?? "Starter";
      button.addEventListener("click", () => {
        starterDialogState.selectedId = project?.id ?? null;
        const selected = getSelectedStarterProject();
        if (appStarterNotes) {
          appStarterNotes.textContent =
            typeof selected?.notes === "string" && selected.notes.trim().length > 0
              ? selected.notes
              : "Starter selected. Enter an app name to continue.";
        }
        if (appStarterConfirmButton) {
          appStarterConfirmButton.disabled = starterDialogState.launching || !starterDialogState.selectedId;
        }
        renderStarterProjectButtons();
      });
      appStarterList.append(button);
    });
  };

  const loadStarterProjects = async () => {
    starterDialogState.loading = true;
    renderStarterProjectButtons();
    try {
      const projects = await fetchStarterProjectsApi();
      starterDialogState.projects = Array.isArray(projects) ? projects : [];
      if (!starterDialogState.projects.some((item) => item?.id === starterDialogState.selectedId)) {
        starterDialogState.selectedId = starterDialogState.projects[0]?.id ?? null;
      }
      const selected = getSelectedStarterProject();
      if (appStarterNotes) {
        appStarterNotes.textContent =
          typeof selected?.notes === "string" && selected.notes.trim().length > 0
            ? selected.notes
            : starterDialogState.selectedId
              ? "Starter selected. Enter an app name to continue."
              : "Select a starter project to continue.";
      }
      if (appStarterConfirmButton) {
        appStarterConfirmButton.disabled = starterDialogState.launching || !starterDialogState.selectedId;
      }
    } catch (error) {
      starterDialogState.projects = [];
      starterDialogState.selectedId = null;
      if (appStarterNotes) {
        appStarterNotes.textContent = error instanceof Error ? error.message : "Failed to load starter projects";
      }
      if (appStarterConfirmButton) {
        appStarterConfirmButton.disabled = true;
      }
    } finally {
      starterDialogState.loading = false;
      renderStarterProjectButtons();
    }
  };

  const updateAppWindowPreview = () => {
    if (!appTmuxWindowInput) return;
    if (appTmuxWindowInput.dataset.locked === "true") return;
    const label = appLabelInput?.value ?? "";
    const root = appRootInput?.value ?? "";
    appTmuxWindowInput.value = deriveAppWindowName(label, root);
  };

  const setAppDialogSubmitting = (submitting) => {
    if (!appForm) return;
    const elements = Array.from(appForm.elements);
    for (const element of elements) {
      if (
        element instanceof HTMLButtonElement ||
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement
      ) {
        if (element.dataset.role === "cancel") continue;
        element.disabled = submitting;
      }
    }
    if (appDialog) {
      if (submitting) {
        appDialog.dataset.submitting = "true";
      } else {
        delete appDialog.dataset.submitting;
      }
    }
  };

  const syncAppWebAppPortNote = ({ enabled, port } = {}) => {
    if (!appWebAppPortNote) return;
    while (appWebAppPortNote.firstChild) {
      appWebAppPortNote.firstChild.remove();
    }
    const hasToggle = appWebAppToggle instanceof HTMLInputElement;
    const isEnabled = typeof enabled === "boolean" ? enabled : hasToggle ? appWebAppToggle.checked : false;
    const assignedPort =
      typeof port === "number"
        ? port
        : typeof appDialogState.webAppPort === "number"
          ? appDialogState.webAppPort
          : null;

    if (!isEnabled) {
      appWebAppPortNote.textContent = "Wingman will assign a dedicated port when you save.";
      return;
    }

    if (typeof assignedPort === "number") {
      appWebAppPortNote.textContent = "Reserved port: ";
      const code = document.createElement("code");
      code.textContent = String(assignedPort);
      appWebAppPortNote.append(code);
      const separator = document.createTextNode(" ");
      appWebAppPortNote.append(separator);
      const href = formatWebAppUrl(assignedPort);
      if (href) {
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Open";
        appWebAppPortNote.append(link);
      }
      return;
    }

    appWebAppPortNote.textContent = "A reserved port will be attached to this app after you save.";
  };

  const clearAppEnvRows = () => {
    if (!appEnvList) return;
    while (appEnvList.firstChild) {
      appEnvList.firstChild.remove();
    }
  };

  const createAppEnvRow = ({ key = "", existing = false } = {}) => {
    if (!appEnvList) return null;

    const row = document.createElement("div");
    row.className = "app-env-row";
    row.dataset.existing = existing ? "true" : "false";
    if (existing) {
      row.dataset.key = key;
    }

    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.autocomplete = "off";
    keyInput.placeholder = "OPENAI_API_KEY";
    keyInput.value = key;
    keyInput.readOnly = existing;
    keyInput.setAttribute("aria-label", "Environment variable name");
    keyInput.dataset.role = "env-key";
    keyInput.dataset.testid = "app-env-key";

    const valueInput = document.createElement("input");
    valueInput.type = "password";
    valueInput.autocomplete = "off";
    valueInput.placeholder = existing ? "Saved value unchanged" : "Value";
    valueInput.setAttribute("aria-label", `Environment variable value${key ? ` for ${key}` : ""}`);
    valueInput.dataset.role = "env-value";
    valueInput.dataset.testid = "app-env-value";

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "wm-button secondary";
    removeButton.textContent = "Remove";
    removeButton.setAttribute("aria-label", key ? `Remove environment variable ${key}` : "Remove environment variable row");
    removeButton.dataset.testid = "app-env-remove";
    removeButton.addEventListener("click", () => {
      row.remove();
    });

    row.append(keyInput, valueInput, removeButton);
    appEnvList.append(row);
    return row;
  };

  const getAppEnvRows = () => {
    if (!appEnvList) return [];
    return Array.from(appEnvList.querySelectorAll(".app-env-row"));
  };

  const populateAppEnvRows = (entries) => {
    clearAppEnvRows();
    const rows = Array.isArray(entries) ? entries : [];
    rows.forEach((entry) => {
      if (!entry || typeof entry.key !== "string" || entry.key.trim().length === 0) return;
      createAppEnvRow({ key: entry.key.trim(), existing: Boolean(entry.hasValue) });
    });
  };

  const collectAppEnvValues = () => {
    const env = [];
    for (const row of getAppEnvRows()) {
      const keyInput = row.querySelector('[data-role="env-key"]');
      const valueInput = row.querySelector('[data-role="env-value"]');
      const key = keyInput instanceof HTMLInputElement ? keyInput.value.trim() : "";
      const value = valueInput instanceof HTMLInputElement ? valueInput.value : "";
      const existing = row.dataset.existing === "true";
      if (!key && !value) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid environment variable key: ${key || "(blank)"}`);
      }
      if (existing && value.length === 0) {
        env.push({ key, retain: true });
      } else {
        env.push({ key, value });
      }
    }
    return env;
  };

  const resetAppDialog = () => {
    if (appForm) {
      appForm.reset();
    }
    if (appDialogTitle) {
      appDialogTitle.textContent = "Add App";
    }
    if (appDiscoverToggle) {
      appDiscoverToggle.checked = true;
    }
    if (appAdvancedSection) {
      appAdvancedSection.open = false;
    }
    Object.values(appScriptInputs).forEach((input) => {
      if (input) {
        input.value = "";
      }
    });
    if (appTmuxInput) {
      appTmuxInput.value = sharedTmuxSession;
    }
    if (appTmuxWindowInput) {
      delete appTmuxWindowInput.dataset.locked;
      appTmuxWindowInput.value = deriveAppWindowName(appLabelInput?.value ?? "", appRootInput?.value ?? "");
    }
    if (appNotesInput) {
      appNotesInput.value = "";
    }
    if (appWebAppToggle) {
      appWebAppToggle.checked = false;
    }
    if (appAutoStartToggle) {
      appAutoStartToggle.checked = false;
    }
    clearAppEnvRows();
    appDialogState.webAppEnabled = false;
    appDialogState.webAppPort = null;
    appDialogState.projectContext = null;
    syncAppWebAppPortNote({ enabled: false, port: null });
    appDialogState.mode = "create";
    appDialogState.appId = null;
    syncAppAdvancedVisibility();
    syncTmuxVisibility();
  };

  const populateAppDialog = (app) => {
    if (!app) return;
    if (appDialogTitle) {
      appDialogTitle.textContent = "Edit App";
    }
    if (appLabelInput) {
      appLabelInput.value = app.label ?? "";
    }
    if (appRootInput) {
      appRootInput.value = app.root ?? "";
    }
    if (appTmuxInput) {
      appTmuxInput.value = sharedTmuxSession;
    }
    if (appTmuxWindowInput) {
      appTmuxWindowInput.dataset.locked = "true";
      appTmuxWindowInput.value =
        app.tmuxWindow ?? app.tmuxSession ?? deriveAppWindowName(app.label ?? "", app.root ?? "");
    }
    if (appNotesInput) {
      appNotesInput.value = app.notes ?? "";
    }
    Object.entries(appScriptInputs).forEach(([action, input]) => {
      if (!input) return;
      input.value = formatLifecycleCommand(app.scripts?.[action]);
    });
    const webAppEnabled = Boolean(app.webApp);
    appDialogState.webAppEnabled = webAppEnabled;
    appDialogState.webAppPort = typeof app.webAppPort === "number" ? app.webAppPort : null;
    if (appWebAppToggle) {
      appWebAppToggle.checked = webAppEnabled;
    }
    if (appAutoStartToggle) {
      appAutoStartToggle.checked = Boolean(app.autoStart ?? app.auto_start);
    }
    populateAppEnvRows(app.env);
    syncAppWebAppPortNote({ enabled: webAppEnabled, port: appDialogState.webAppPort });
    if (appAdvancedSection && !appAdvancedSection.hidden) {
      const hasScript = Object.values(app.scripts ?? {}).some(
        (value) => Boolean(value?.executable),
      );
      const inferredWindow = deriveAppWindowName(app.label ?? "", app.root ?? "");
      const hasCustomWindow = Boolean(app.tmuxWindow && app.tmuxWindow !== inferredWindow);
      const hasManagedEnv = Array.isArray(app.env) && app.env.length > 0;
      appAdvancedSection.open = hasScript || hasCustomWindow || hasManagedEnv;
    }
    syncAppAdvancedVisibility();
    syncTmuxVisibility();
  };

  const collectAppFormValues = () => {
    const label = appLabelInput?.value?.trim() ?? "";
    const root = appRootInput?.value?.trim() ?? "";
    const notesRaw = appNotesInput?.value ?? "";
    const notesTrimmed = notesRaw.trim();
    const scripts = {};
    for (const [action, input] of Object.entries(appScriptInputs)) {
      if (!input) continue;
      const value = input.value.trim();
      if (value.length > 0) {
        scripts[action] = parseLifecycleCommand(value);
      }
    }
    const discoverScripts = appDiscoverToggle ? appDiscoverToggle.checked : true;
    const webApp = appWebAppToggle ? appWebAppToggle.checked : false;
    const autoStart = appAutoStartToggle ? appAutoStartToggle.checked : false;
    const env = collectAppEnvValues();
    return { label, root, notesRaw, notesTrimmed, scripts, discoverScripts, webApp, autoStart, env };
  };

  const handleAppFormSubmit = async (event) => {
    event.preventDefault();
    let values;
    try {
      values = collectAppFormValues();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid app form values";
      showToast(message, { type: "warning" });
      return;
    }
    if (!values.root) {
      showToast("Provide a root directory for the app.", { type: "warning" });
      appRootInput?.focus();
      return;
    }

    const scriptsPayload = Object.keys(values.scripts).length > 0 ? values.scripts : undefined;
    const mode = appDialogState.mode;
    const appId = appDialogState.appId;
    const projectContext = appDialogState.projectContext;

    let url;
    let method;
    let body;

    if (mode === "edit" && appId) {
      url = `/api/apps/${encodeURIComponent(appId)}`;
      method = "PUT";
      body = {
        label: values.label ? values.label : undefined,
        root: values.root,
        scripts: scriptsPayload,
        notes:
          values.notesRaw.length === 0
            ? null
            : values.notesTrimmed.length > 0
              ? values.notesTrimmed
              : undefined,
        discoverScripts: values.discoverScripts,
        webApp: values.webApp,
        autoStart: values.autoStart,
        auto_start: values.autoStart,
        env: values.env,
      };
    } else {
      url = "/api/apps";
      method = "POST";
      body = {
        label: values.label,
        root: values.root,
        scripts: scriptsPayload,
        notes: values.notesTrimmed.length > 0 ? values.notesTrimmed : undefined,
        discoverScripts: values.discoverScripts,
        webApp: values.webApp,
        autoStart: values.autoStart,
        auto_start: values.autoStart,
        env: values.env,
      };
    }

    setAppDialogSubmitting(true);
    try {
      const response = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to save app";
        throw new Error(message);
      }
      const createdApp = mode === "create" ? payload?.app : null;
      closeAppDialog();
      await refreshApps({ skipRender: false });
      if (createdApp && projectContext) {
        await linkAppToProject(projectContext, createdApp);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save app";
      showToast(message, { type: "error" });
    } finally {
      setAppDialogSubmitting(false);
    }
  };

  const closeAppDialog = () => {
    closeAppNewModeDialog();
    closeAppStarterDialog();
    if (!appDialog) return;
    if (appDialog.open) {
      appDialog.close();
    }
    resetAppDialog();
  };

  const closeAppNewModeDialog = () => {
    if (!appNewModeDialog) return;
    if (appNewModeDialog.open) {
      appNewModeDialog.close();
    }
  };

  const openAppNewModeDialog = () => {
    if (!appNewModeDialog) {
      openManualAppDialog();
      return;
    }
    if (appNewModeDialog.open) {
      appNewModeDialog.close();
    }
    appNewModeDialog.showModal();
  };

  const closeAppStarterDialog = () => {
    if (!appStarterDialog) return;
    if (appStarterDialog.open) {
      appStarterDialog.close();
    }
    appStarterForm?.reset();
    starterDialogState.selectedId = null;
    starterDialogState.projects = [];
    starterDialogState.loading = false;
    starterDialogState.launching = false;
    if (appStarterGitHubRepoInput) {
      appStarterGitHubRepoInput.dataset.locked = "false";
    }
    if (appStarterNotes) {
      appStarterNotes.textContent = "Select a starter project to continue.";
    }
  };

  const openAppStarterDialog = async () => {
    closeAppNewModeDialog();
    if (!appStarterDialog) {
      openManualAppDialog();
      return;
    }
    appStarterForm?.reset();
    if (appStarterNameInput && appLabelInput && appLabelInput.value.trim().length > 0) {
      appStarterNameInput.value = appLabelInput.value.trim();
    }
    syncStarterRepoName();
    if (appStarterNotes) {
      appStarterNotes.textContent = "Loading starter projects...";
    }
    if (appStarterDialog.open) {
      appStarterDialog.close();
    }
    appStarterDialog.showModal();
    appStarterNameInput?.focus();
    await loadStarterProjects();
  };

  const openManualAppDialog = (appId = null, options = {}) => {
    if (!appDialog) return;
    closeAppNewModeDialog();
    closeAppStarterDialog();
    resetAppDialog();
    if (options?.projectContext) {
      appDialogState.projectContext = options.projectContext;
      if (appDialogTitle) {
        const projectName = options.projectContext.projectName?.trim();
        appDialogTitle.textContent = projectName ? `Add App · ${projectName}` : "Add App";
      }
      if (appRootInput && options.projectContext.rootPath) {
        appRootInput.value = options.projectContext.rootPath;
        updateAppWindowPreview();
      }
      if (appLabelInput && options.projectContext.defaultLabel && !appLabelInput.value) {
        appLabelInput.value = options.projectContext.defaultLabel;
        updateAppWindowPreview();
      }
    }
    if (appId) {
      const app = getAppById(appId);
      if (!app) return;
      appDialogState.mode = "edit";
      appDialogState.appId = appId;
      populateAppDialog(app);
    }
    if (appDialog.open) {
      appDialog.close();
    }
    appDialog.showModal();
    (appLabelInput ?? appRootInput)?.focus();
  };

  const openAppDialog = (appId = null, options = {}) => {
    if (appId) {
      openManualAppDialog(appId, options);
      return;
    }
    if (options?.manual === true || options?.projectContext) {
      openManualAppDialog(null, options);
      return;
    }
    openAppNewModeDialog();
  };

  const applyDiscoveredScripts = (scripts, { revealAdvanced = true } = {}) => {
    if (!scripts || typeof scripts !== "object") {
      return 0;
    }
    let applied = 0;
    for (const [action, input] of Object.entries(appScriptInputs)) {
      if (!input) continue;
      const candidate = scripts?.[action];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        input.value = candidate;
        applied += 1;
      }
    }
    if (applied > 0 && revealAdvanced && appAdvancedSection && !appAdvancedSection.hidden) {
      appAdvancedSection.open = true;
    }
    return applied;
  };

  const runScriptDiscovery = async ({ root, silent = false, revealAdvanced = true } = {}) => {
    const targetRoot = typeof root === "string" ? root.trim() : appRootInput?.value?.trim() ?? "";
    if (!targetRoot) {
      if (!silent) {
        showToast("Enter the app root directory before discovering scripts.", { type: "warning" });
        appRootInput?.focus();
      }
      return { applied: 0, success: false };
    }
    try {
      const response = await fetch(`/api/apps/discover?root=${encodeURIComponent(targetRoot)}`);
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to discover scripts";
        throw new Error(message);
      }
      const scripts = payload && typeof payload === "object" ? (payload.scripts ?? {}) : {};
      const applied = applyDiscoveredScripts(scripts, { revealAdvanced });
      if (!silent && applied === 0) {
        showToast("No scripts discovered. Enter commands manually.", { type: "info" });
      }
      return { applied, success: true };
    } catch (error) {
      if (!silent) {
        const message = error instanceof Error ? error.message : "Failed to discover scripts";
        showToast(message, { type: "error" });
      } else {
        console.warn("[apps] Script discovery failed", error);
      }
      return { applied: 0, success: false };
    }
  };

  const handleAppDiscover = async (event) => {
    event.preventDefault();
    if (appDiscoverButton) {
      appDiscoverButton.disabled = true;
    }
    try {
      await runScriptDiscovery({ silent: false, revealAdvanced: true });
    } finally {
      if (appDiscoverButton) {
        appDiscoverButton.disabled = false;
      }
    }
  };

  const applyClonedAppDefaults = (payload) => {
    if (!payload || typeof payload !== "object") return "";
    const root = typeof payload.root === "string" ? payload.root : "";
    if (root && appRootInput) {
      appRootInput.value = root;
      updateAppWindowPreview();
      state.lastWorkingDirectory = root;
    }
    const suggestedLabel = typeof payload.label === "string" ? payload.label : "";
    if (suggestedLabel && appLabelInput && appLabelInput.value.trim().length === 0) {
      appLabelInput.value = suggestedLabel;
      updateAppWindowPreview();
    }
    const scripts = payload.scripts;
    if (scripts && typeof scripts === "object") {
      let applied = 0;
      for (const [action, command] of Object.entries(scripts)) {
        const input = appScriptInputs[action];
        if (!input || typeof command !== "string") continue;
        if (input.value.trim().length === 0) {
          input.value = command;
          applied += 1;
        }
      }
      if (applied > 0 && appAdvancedSection && !appAdvancedSection.hidden) {
        appAdvancedSection.open = true;
      }
    }
    if (appDiscoverToggle) {
      appDiscoverToggle.checked = false;
    }
    return root;
  };

  const closeAppCloneDialog = () => {
    if (!appCloneDialog) return;
    if (appCloneDialog.open) {
      appCloneDialog.close();
    }
    appCloneForm?.reset();
  };

  const openAppCloneDialog = () => {
    if (!appCloneDialog) return;
    appCloneForm?.reset();
    if (appCloneNameInput && appLabelInput && appLabelInput.value.trim().length > 0) {
      appCloneNameInput.value = appLabelInput.value.trim().toLowerCase().replace(/\s+/g, "-");
    }
    appCloneDialog.showModal();
    appCloneUrlInput?.focus();
  };

  const handleAppCloneSubmit = async (event) => {
    event.preventDefault();
    if (!appCloneUrlInput || !appCloneConfirmButton) return;
    const repoUrl = appCloneUrlInput.value.trim();
    let folderName = appCloneNameInput?.value.trim() ?? "";
    if (!repoUrl) {
      showToast("Provide a repository URL to clone.", { type: "warning" });
      appCloneUrlInput.focus();
      return;
    }
    if (!folderName) {
      folderName = deriveRepositoryFolderName(repoUrl);
      if (appCloneNameInput) {
        appCloneNameInput.value = folderName;
      }
    }
    if (!folderName) {
      showToast("Provide a folder name for the cloned repository.", { type: "warning" });
      appCloneNameInput?.focus();
      return;
    }

    appCloneConfirmButton.disabled = true;
    try {
      const response = await fetch("/api/apps/clone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: repoUrl, directory: folderName }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to clone repository";
        throw new Error(message);
      }
      const appliedRoot = applyClonedAppDefaults(payload ?? {}) ?? "";
      if (payload && typeof payload === "object" && typeof payload.root === "string" && appCloneNameInput) {
        const labelSuggestion =
          typeof payload.label === "string" && payload.label.trim().length > 0
            ? payload.label.trim()
            : humaniseFolderLabel(folderName);
        if (labelSuggestion && appLabelInput && appLabelInput.value.trim().length === 0) {
          appLabelInput.value = labelSuggestion;
          updateAppWindowPreview();
        }
      }
      if (appliedRoot) {
        void runScriptDiscovery({ root: appliedRoot, silent: true, revealAdvanced: false });
      }
      closeAppCloneDialog();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to clone repository";
      showToast(message, { type: "error" });
    } finally {
      appCloneConfirmButton.disabled = false;
    }
  };

  const handleStarterSubmit = async (event) => {
    event.preventDefault();
    if (starterDialogState.launching) return;
    const selected = getSelectedStarterProject();
    if (!selected?.id) {
      showToast("Select a starter project.", { type: "warning" });
      return;
    }
    const name = appStarterNameInput?.value?.trim() ?? "";
    if (!name) {
      showToast("Provide a name for the starter app.", { type: "warning" });
      appStarterNameInput?.focus();
      return;
    }
    const githubOwner = appStarterGitHubOwnerInput?.value?.trim() ?? "";
    if (!githubOwner) {
      showToast("Provide a GitHub owner or organization.", { type: "warning" });
      appStarterGitHubOwnerInput?.focus();
      return;
    }
    const githubRepo = appStarterGitHubRepoInput?.value?.trim() ?? "";
    if (!githubRepo) {
      showToast("Provide a GitHub repository name.", { type: "warning" });
      appStarterGitHubRepoInput?.focus();
      return;
    }
    setStarterDialogSubmitting(true);
    try {
      const payload = await launchStarterProjectApi({
        starterId: selected.id,
        name,
        githubOwner,
        githubRepo,
        private: appStarterPrivateInput ? Boolean(appStarterPrivateInput.checked) : true,
        protectBranches: appStarterProtectInput ? Boolean(appStarterProtectInput.checked) : true,
        createDeployedBranch: true,
      });
      closeAppStarterDialog();
      await refreshApps({ skipRender: false });
      const setupStatus = payload?.setup?.status;
      const setupAttempted = Boolean(payload?.setup?.attempted);
      const startStatus = payload?.start?.status;
      const startAttempted = Boolean(payload?.start?.attempted);
      const startError = typeof payload?.start?.error === "string" ? payload.start.error.trim() : "";
      const warnings = Array.isArray(payload?.github?.protection?.warnings) ? payload.github.protection.warnings : [];
      if (setupAttempted) {
        const exitCode = typeof setupStatus?.lastExitCode === "number" ? setupStatus.lastExitCode : null;
        const setupMessage = typeof setupStatus?.message === "string" ? setupStatus.message : "";
        if (exitCode !== 0) {
          showToast(
            setupMessage
              ? `Starter created, but setup failed: ${setupMessage}`
              : "Starter created, but setup failed. Open the WApp card logs for details.",
            { type: "error", duration: 10000 },
          );
        } else if (startAttempted && startStatus?.status !== "running") {
          const startMessage = startError || (typeof startStatus?.message === "string" ? startStatus.message : "");
          showToast(
            startMessage
              ? `Starter setup completed, but start failed: ${startMessage}`
              : "Starter setup completed, but start failed. Open the WApp card logs for details.",
            { type: "error", duration: 10000 },
          );
        } else if (startAttempted) {
          showToast("Starter project created, setup completed, and app started", { type: "success" });
        } else {
          showToast("Starter project created and setup completed", { type: "success" });
        }
      } else if (warnings.length > 0) {
        showToast(`Starter project created, but branch protection needs review: ${warnings[0]}`, { type: "warning", duration: 8000 });
      } else {
        showToast("Starter repo and app created", { type: "success" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to launch starter project";
      showToast(message, { type: "error" });
    } finally {
      setStarterDialogSubmitting(false);
    }
  };

  const openAppLogsDialog = async (appId) => {
    if (!appLogsDialog) return;
    const app = getAppById(appId);
    if (appLogsTitle) {
      appLogsTitle.textContent = app?.label ?? appId;
    }
    state.appLogViewer.appId = appId;
    state.appLogViewer.title = app?.label ?? appId;
    state.appLogViewer.lines = [];
    state.appLogViewer.loading = true;
    if (appLogsContent) {
      appLogsContent.textContent = "Loading logs…";
    }
    if (appLogsDialog.open) {
      appLogsDialog.close();
    }
    appLogsDialog.showModal();
    await refreshAppLogs(appId);
  };

  const refreshAppLogs = async (appId, { tail } = {}) => {
    const targetId = appId ?? state.appLogViewer.appId;
    if (!targetId) return;
    const tailSize = typeof tail === "number" && tail > 0 ? tail : state.appLogViewer.tail;
    state.appLogViewer.loading = true;
    try {
      const response = await fetch(
        `/api/apps/${encodeURIComponent(targetId)}/logs?tail=${encodeURIComponent(String(tailSize))}`,
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to load logs";
        throw new Error(message);
      }
      const lines = Array.isArray(payload?.logs) ? payload.logs : [];
      state.appLogViewer.lines = lines;
      if (appLogsContent) {
        appLogsContent.textContent = lines.length > 0 ? lines.join("\n") : "No log output yet.";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load logs";
      if (appLogsContent) {
        appLogsContent.textContent = `Error: ${message}`;
      }
    } finally {
      state.appLogViewer.loading = false;
    }
  };

  const clearAppLogs = async (appId) => {
    const targetId = appId ?? state.appLogViewer.appId;
    if (!targetId) return;
    const app = getAppById(targetId);
    const appName = app?.label ?? targetId;
    const confirmed = await openConfirmDialog({
      title: "Clear App Logs",
      description: `Clear logs for "${appName}"?`,
      confirmLabel: "Clear",
      testId: "clear-app-logs-dialog",
    });
    if (!confirmed) return;

    if (appLogsClearButton) {
      appLogsClearButton.disabled = true;
      appLogsClearButton.textContent = "Clearing…";
    }
    try {
      const response = await fetch(`/api/apps/${encodeURIComponent(targetId)}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "clear-logs" }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to clear logs";
        throw new Error(message);
      }
      state.appLogViewer.lines = [];
      if (appLogsContent) {
        appLogsContent.textContent = "No log output yet.";
      }
      showToast("Logs cleared", { type: "success" });
      await refreshAppLogs(targetId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to clear logs";
      showToast(message, { type: "error" });
    } finally {
      if (appLogsClearButton) {
        appLogsClearButton.disabled = false;
        appLogsClearButton.textContent = "Clear logs";
      }
    }
  };

  const closeAppLogsDialog = () => {
    if (!appLogsDialog) return;
    if (appLogsDialog.open) {
      appLogsDialog.close();
      return;
    }
    state.appLogViewer.appId = null;
    state.appLogViewer.title = "";
    state.appLogViewer.lines = [];
    state.appLogViewer.loading = false;
  };

  if (appLabelInput) {
    appLabelInput.addEventListener("input", () => {
      if (appDialogState.mode === "edit" && appTmuxWindowInput?.dataset.locked === "true") {
        return;
      }
      updateAppWindowPreview();
    });
  }

  if (appRootInput) {
    appRootInput.addEventListener("input", () => {
      if (appDialogState.mode === "edit" && appTmuxWindowInput?.dataset.locked === "true") {
        return;
      }
      updateAppWindowPreview();
    });
  }

  if (appWebAppToggle) {
    appWebAppToggle.addEventListener("change", () => {
      const enabled = appWebAppToggle.checked;
      appDialogState.webAppEnabled = enabled;
      syncAppWebAppPortNote({ enabled, port: enabled ? appDialogState.webAppPort : null });
    });
  }

  appRootBrowseButton?.addEventListener("click", (event) => {
    event.preventDefault();
    const seed =
      appRootInput?.value?.trim() || state.lastWorkingDirectory || state.config?.defaultDirectory || "";
    void openDirectoryBrowser({
      initialPath: seed,
      title: "Select App Root",
      confirmLabel: "Use This Directory",
      allowCreate: true,
      onSelect: (path) => {
        if (appRootInput) {
          appRootInput.value = path;
          updateAppWindowPreview();
        }
        state.lastWorkingDirectory = path;
      },
    });
  });

  appCloneDialog?.addEventListener("close", () => {
    appCloneForm?.reset();
  });

  appNewModeQuickButton?.addEventListener("click", (event) => {
    event.preventDefault();
    void openAppStarterDialog();
  });

  appNewModeManualButton?.addEventListener("click", (event) => {
    event.preventDefault();
    closeAppNewModeDialog();
    openManualAppDialog();
  });

  appNewModeCancelButton?.addEventListener("click", (event) => {
    event.preventDefault();
    closeAppNewModeDialog();
  });

  appNewModeDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeAppNewModeDialog();
  });

  appStarterCancelButton?.addEventListener("click", (event) => {
    event.preventDefault();
    closeAppStarterDialog();
  });

  appStarterDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeAppStarterDialog();
  });

  appStarterDialog?.addEventListener("close", () => {
    appStarterForm?.reset();
    if (appStarterGitHubRepoInput) {
      appStarterGitHubRepoInput.dataset.locked = "false";
    }
  });

  appStarterForm?.addEventListener("submit", (event) => {
    void handleStarterSubmit(event);
  });

  appStarterNameInput?.addEventListener("input", () => {
    syncStarterRepoName();
  });

  appStarterGitHubRepoInput?.addEventListener("input", () => {
    appStarterGitHubRepoInput.dataset.locked = "true";
  });

  appCloneButton?.addEventListener("click", (event) => {
    event.preventDefault();
    openAppCloneDialog();
  });

  appCloneCancelButton?.addEventListener("click", (event) => {
    event.preventDefault();
    closeAppCloneDialog();
  });

  appCloneForm?.addEventListener("submit", handleAppCloneSubmit);

  appCloneDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeAppCloneDialog();
  });

  if (typeof window !== "undefined") {
    window.addEventListener("wingman:identity-ui-state", () => {
      syncAppAdvancedVisibility();
      syncTmuxVisibility();
    });
  }

  appCloneUrlInput?.addEventListener("blur", () => {
    if (!appCloneNameInput || !appCloneUrlInput) return;
    if (appCloneNameInput.value.trim().length > 0) return;
    const derived = deriveRepositoryFolderName(appCloneUrlInput.value);
    if (derived) {
      appCloneNameInput.value = derived;
    }
  });

  appForm?.addEventListener("submit", handleAppFormSubmit);

  appDiscoverButton?.addEventListener("click", handleAppDiscover);

  appEnvAddButton?.addEventListener("click", (event) => {
    event.preventDefault();
    const row = createAppEnvRow();
    const keyInput = row?.querySelector('[data-role="env-key"]');
    if (keyInput instanceof HTMLInputElement) {
      keyInput.focus();
    }
  });

  appCancelButton?.addEventListener("click", (event) => {
    event.preventDefault();
    closeAppDialog();
  });

  appDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeAppDialog();
  });

  appDialog?.addEventListener("close", () => {
    resetAppDialog();
  });

  appLogsRefreshButton?.addEventListener("click", (event) => {
    event.preventDefault();
    void refreshAppLogs();
  });

  appLogsClearButton?.addEventListener("click", (event) => {
    event.preventDefault();
    void clearAppLogs();
  });

  appLogsCloseButton?.addEventListener("click", (event) => {
    event.preventDefault();
    closeAppLogsDialog();
  });

  appLogsDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeAppLogsDialog();
  });

  appLogsDialog?.addEventListener("close", () => {
    closeAppLogsDialog();
  });

  // ============================================================
  // Deploy Dialog
  // ============================================================

  const appDeployDialog = document.getElementById("app-deploy-dialog");
  const appDeployForm = appDeployDialog?.querySelector("form") ?? null;
  const appDeployTitle = document.getElementById("app-deploy-title");
  const appDeployNameInput = document.getElementById("app-deploy-name");
  const appDeployTargetSelect = document.getElementById("app-deploy-target");
  const appDeployEnableHttpsInput = document.getElementById("app-deploy-enable-https");
  const appDeployStatus = document.getElementById("app-deploy-status");
  const appDeployMessage = document.getElementById("app-deploy-message");
  const appDeployUrl = document.getElementById("app-deploy-url");
  const appDeployCancelButton = document.getElementById("app-deploy-cancel");
  const appDeployConfirmButton = document.getElementById("app-deploy-confirm");
  const appCaproverDialog = document.getElementById("app-caprover-dialog");
  const appCaproverForm = appCaproverDialog?.querySelector("form") ?? null;
  const appCaproverTitle = document.getElementById("app-caprover-title");
  const appCaproverNameInput = document.getElementById("app-caprover-name");
  const appCaproverDeployments = document.getElementById("app-caprover-deployments");
  const appCaproverTargetSelect = document.getElementById("app-caprover-target");
  const appCaproverCopySourceSelect = document.getElementById("app-caprover-copy-source");
  const appCaproverRefreshButton = document.getElementById("app-caprover-refresh");
  const appCaproverRepoInput = document.getElementById("app-caprover-repo");
  const appCaproverBranchInput = document.getElementById("app-caprover-branch");
  const appCaproverEnableHttpsInput = document.getElementById("app-caprover-enable-https");
  const appCaproverEnvVarsInput = document.getElementById("app-caprover-env-vars");
  const appCaproverUserInput = document.getElementById("app-caprover-user");
  const appCaproverPasswordInput = document.getElementById("app-caprover-password");
  const appCaproverSshKeyInput = document.getElementById("app-caprover-ssh-key");
  const appCaproverStatus = document.getElementById("app-caprover-status");
  const appCaproverMessage = document.getElementById("app-caprover-message");
  const appCaproverWebhookRow = document.getElementById("app-caprover-webhook-row");
  const appCaproverWebhookInput = document.getElementById("app-caprover-webhook");
  const appCaproverCopyWebhookButton = document.getElementById("app-caprover-copy-webhook");
  const appCaproverUrl = document.getElementById("app-caprover-url");
  const appCaproverCancelButton = document.getElementById("app-caprover-cancel");
  const appCaproverReplicateButton = document.getElementById("app-caprover-replicate");
  const appCaproverSaveButton = document.getElementById("app-caprover-save");

  const deployDialogState = {
    appId: null,
    deploying: false,
    completed: false,
    targets: [],
  };

  const caproverDialogState = {
    appId: null,
    targets: [],
    deployments: [],
    saving: false,
    preferredName: "",
  };

  const readJsonResponse = async (response, fallbackMessage) => {
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    const trimmed = text.trim();
    if (contentType.includes("application/json")) {
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        throw new Error(response.ok ? "Invalid JSON response from server" : fallbackMessage);
      }
    }
    if (!response.ok) {
      if (/^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
        throw new Error(`${fallbackMessage}: server returned HTML instead of JSON. Check the request origin and backend route.`);
      }
      throw new Error(trimmed ? `${fallbackMessage}: ${trimmed.slice(0, 220)}` : `${fallbackMessage}: ${response.status}`);
    }
    if (/^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
      throw new Error("Server returned HTML instead of JSON. The request likely hit the wrong origin or an old backend route.");
    }
    throw new Error(trimmed ? trimmed.slice(0, 220) : "Server returned a non-JSON response");
  };

  const setDeployConfirmButtonState = (label, disabled) => {
    if (!appDeployConfirmButton) return;
    appDeployConfirmButton.disabled = disabled;
    appDeployConfirmButton.textContent = label;
  };

  const setDeployDialogCompletionState = (completed) => {
    deployDialogState.completed = completed;
    if (appDeployNameInput) {
      appDeployNameInput.disabled = completed;
    }
    if (appDeployTargetSelect) {
      appDeployTargetSelect.disabled = completed;
    }
    if (appDeployEnableHttpsInput) {
      appDeployEnableHttpsInput.disabled = completed;
    }
    if (appDeployCancelButton) {
      appDeployCancelButton.hidden = completed;
    }
  };

  const renderCaproverTargetOptions = (targets) => {
    if (!appDeployTargetSelect) return;
    appDeployTargetSelect.replaceChildren();

    if (targets.length > 1) {
      const allOption = document.createElement("option");
      allOption.value = "all";
      allOption.textContent = "All configured targets";
      appDeployTargetSelect.append(allOption);
    }

    for (const target of targets) {
      const option = document.createElement("option");
      option.value = target.name;
      option.textContent = target.name;
      appDeployTargetSelect.append(option);
    }

    appDeployTargetSelect.disabled = targets.length <= 1;
    appDeployTargetSelect.value = targets.length > 1 ? "all" : targets[0]?.name ?? "all";
  };

  const fetchCaproverTargets = async () => {
    const response = await fetch("/api/caprover/targets");
    const data = await readJsonResponse(response, "Failed to load CapRover targets");
    if (!response.ok) {
      throw new Error(data.error || response.statusText || "Failed to load CapRover targets");
    }
    return Array.isArray(data.targets) ? data.targets : [];
  };

  const loadCaproverTargets = async () => {
    try {
      const targets = await fetchCaproverTargets();
      deployDialogState.targets = targets;
      renderCaproverTargetOptions(targets);
      return targets;
    } catch {
      deployDialogState.targets = [];
      renderCaproverTargetOptions([]);
      return [];
    }
  };

  const formatDeployResultMessage = (data) => {
    const targets = Array.isArray(data?.targets) ? data.targets : [];
    if (targets.length === 0) return "Deployment successful!";

    const successful = targets.filter((target) => target.success);
    const failed = targets.filter((target) => !target.success);
    const httpsFailed = targets.filter((target) => target.success && target.httpsError);
    if (failed.length === 0) {
      if (httpsFailed.length > 0) {
        return `Deployment successful on ${successful.map((target) => target.targetName).join(", ")}. HTTPS failed on ${httpsFailed.map((target) => target.targetName).join(", ")}.`;
      }
      return `Deployment successful on ${successful.map((target) => target.targetName).join(", ")}.`;
    }

    return `Deployed to ${successful.map((target) => target.targetName).join(", ")}. Failed on ${failed.map((target) => target.targetName).join(", ")}.`;
  };

  const resolveInitialCaproverName = (app) => {
    if (typeof app?.caproverName === "string" && app.caproverName.trim().length > 0) {
      return app.caproverName.trim();
    }
    if (typeof app?.subdomainAlias === "string" && app.subdomainAlias.trim().length > 0) {
      return app.subdomainAlias.trim();
    }
    if (typeof app?.label === "string") {
      return deriveCaproverNameFromLabel(app.label);
    }
    return "";
  };

  const syncDeployedAppDetails = (appId, deployment) => {
    const app = getAppById(appId);
    if (!app || !deployment || typeof deployment !== "object") return;
    if (typeof deployment.caproverName === "string" && deployment.caproverName.length > 0) {
      app.caproverName = deployment.caproverName;
    }
    if (typeof deployment.liveUrl === "string" && deployment.liveUrl.length > 0) {
      app.caproverLiveUrl = deployment.liveUrl;
    }
    if (typeof deployment.deployedVersion === "number") {
      app.caproverDeployedVersion = deployment.deployedVersion;
    }
  };

  const syncCaproverSetupDetails = (appId, data) => {
    const app = getAppById(appId);
    if (!app || !data || typeof data !== "object") return;
    const caprover = data.caprover && typeof data.caprover === "object" ? data.caprover : null;
    if (caprover?.appName) {
      app.caproverName = caprover.appName;
    }
    if (caprover?.liveUrl) {
      app.caproverLiveUrl = caprover.liveUrl;
    }
    if (typeof caprover?.deployedVersion === "number") {
      app.caproverDeployedVersion = caprover.deployedVersion;
    }
  };

  const setCaproverStatus = (message, type = "pending") => {
    if (appCaproverStatus) {
      appCaproverStatus.hidden = !message;
    }
    if (appCaproverMessage) {
      appCaproverMessage.textContent = message || "";
      appCaproverMessage.className =
        type === "error" ? "wm-deploy-error" : type === "success" ? "wm-deploy-success" : "wm-deploy-pending";
    }
  };

  const setCaproverWebhook = (url) => {
    const hasUrl = typeof url === "string" && url.trim().length > 0;
    if (appCaproverWebhookRow) {
      appCaproverWebhookRow.hidden = !hasUrl;
    }
    if (appCaproverWebhookInput) {
      appCaproverWebhookInput.value = hasUrl ? url.trim() : "";
    }
  };

  const getCaproverReplicationDestination = () => appCaproverTargetSelect?.value || "";
  const getCaproverReplicationSource = () => appCaproverCopySourceSelect?.value || "";

  const updateCaproverReplicateButton = () => {
    if (!appCaproverReplicateButton) return;
    const destination = getCaproverReplicationDestination();
    const source = getCaproverReplicationSource();
    const sourceDeployment = caproverDialogState.deployments.find((entry) => entry?.name === source);
    appCaproverReplicateButton.disabled =
      !source ||
      !destination ||
      source === destination ||
      !sourceDeployment?.linked ||
      Boolean(sourceDeployment?.error) ||
      caproverDialogState.saving;
  };

  const renderCaproverSetupTargets = (targets) => {
    if (!appCaproverTargetSelect) return;
    const previousDestination = appCaproverTargetSelect.value;
    const previousSource = appCaproverCopySourceSelect?.value || "";
    appCaproverTargetSelect.replaceChildren();
    for (const target of targets) {
      const option = document.createElement("option");
      option.value = target.name;
      option.textContent = target.name;
      appCaproverTargetSelect.append(option);
    }
    appCaproverTargetSelect.disabled = targets.length <= 1;
    const destinationTarget =
      targets.find((target) => target.name === previousDestination) ??
      targets.find((target) => target.name !== "primary") ??
      targets[0];
    appCaproverTargetSelect.value = destinationTarget?.name ?? "";

    if (appCaproverCopySourceSelect) {
      appCaproverCopySourceSelect.replaceChildren();
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Select source target";
      appCaproverCopySourceSelect.append(placeholder);
      const sourceTargetNames = new Set(
        caproverDialogState.deployments
          .filter((entry) => entry?.linked && !entry?.error)
          .map((entry) => entry.name),
      );
      for (const target of targets) {
        const option = document.createElement("option");
        option.value = target.name;
        option.textContent = target.name;
        option.disabled = sourceTargetNames.size > 0 && !sourceTargetNames.has(target.name);
        appCaproverCopySourceSelect.append(option);
      }
      appCaproverCopySourceSelect.disabled = targets.length <= 1;
      const preferredSource =
        targets.find((target) => target.name === previousSource && (sourceTargetNames.size === 0 || sourceTargetNames.has(target.name))) ??
        targets.find((target) => target.name === "primary" && sourceTargetNames.has(target.name)) ??
        targets.find((target) => sourceTargetNames.has(target.name)) ??
        targets.find((target) => target.name === "primary") ??
        targets[0];
      appCaproverCopySourceSelect.value = preferredSource?.name ?? "";
    }
    updateCaproverReplicateButton();
  };

  const renderCaproverDeploymentSummary = (deployments) => {
    if (!appCaproverDeployments) return;
    appCaproverDeployments.replaceChildren();
    if (!Array.isArray(deployments) || deployments.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-field-note";
      empty.textContent = "No CapRover targets are configured.";
      appCaproverDeployments.append(empty);
      return;
    }

    for (const deployment of deployments) {
      const row = document.createElement("div");
      row.className = "wm-caprover-deployment-row";
      row.dataset.state = deployment.error ? "error" : deployment.linked ? "linked" : "missing";

      const main = document.createElement("div");
      main.className = "wm-caprover-deployment-main";
      const title = document.createElement("strong");
      title.textContent = deployment.name;
      const detail = document.createElement("span");
      if (deployment.error) {
        detail.textContent = deployment.error;
      } else if (deployment.linked) {
        const branch = deployment.app?.gitDeploy?.branch ? `branch ${deployment.app.gitDeploy.branch}` : "GitHub deploy not configured";
        const version = deployment.app?.deployedVersion !== null && deployment.app?.deployedVersion !== undefined
          ? `v${deployment.app.deployedVersion}`
          : "no build yet";
        detail.textContent = `${branch} - ${version}`;
      } else {
        detail.textContent = "Not registered";
      }
      main.append(title, detail);

      const badge = document.createElement("span");
      badge.className = "wm-app-status";
      badge.dataset.state = deployment.error ? "failed" : deployment.linked ? "running" : "idle";
      badge.textContent = deployment.error ? "Error" : deployment.linked ? "Registered" : "Missing";
      row.append(main, badge);

      if (deployment.liveUrl) {
        const link = document.createElement("a");
        link.href = deployment.liveUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Open";
        row.append(link);
      }

      appCaproverDeployments.append(row);
    }
  };

  const loadCaproverDeploymentSummary = async () => {
    const appId = caproverDialogState.appId;
    if (!appId) return [];
    const caproverName = appCaproverNameInput?.value?.trim() || caproverDialogState.preferredName;
    if (!caproverName) {
      renderCaproverDeploymentSummary([]);
      return [];
    }
    try {
      const response = await fetch(
        `/api/apps/${encodeURIComponent(appId)}/caprover/deployments?caproverName=${encodeURIComponent(caproverName)}`,
      );
      const data = await readJsonResponse(response, "Failed to load CapRover deployments");
      if (!response.ok) {
        throw new Error(data.error || response.statusText || "Failed to load CapRover deployments");
      }
      caproverDialogState.deployments = Array.isArray(data.targets) ? data.targets : [];
      renderCaproverSetupTargets(caproverDialogState.targets);
      renderCaproverDeploymentSummary(caproverDialogState.deployments);
      applyDeploymentForSelectedTarget();
      return caproverDialogState.deployments;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load CapRover deployments";
      renderCaproverDeploymentSummary([{ name: "CapRover", linked: false, app: null, liveUrl: null, error: message }]);
      setCaproverStatus(message, "error");
      return [];
    }
  };

  const applyDeploymentForSelectedTarget = () => {
    const targetName = appCaproverTargetSelect?.value || "";
    const deployment = caproverDialogState.deployments.find((entry) => entry?.name === targetName);
    if (deployment?.app) {
      applyRemoteCaproverAppToForm(deployment.app);
    }
  };

  const applyRemoteCaproverAppToForm = (remoteApp) => {
    if (!remoteApp) return;
    const gitDeploy = remoteApp.gitDeploy && typeof remoteApp.gitDeploy === "object" ? remoteApp.gitDeploy : null;
    if (appCaproverRepoInput) {
      appCaproverRepoInput.value = typeof gitDeploy?.repo === "string" ? gitDeploy.repo : "";
    }
    if (appCaproverBranchInput) {
      appCaproverBranchInput.value = typeof gitDeploy?.branch === "string" && gitDeploy.branch ? gitDeploy.branch : "";
    }
    if (appCaproverEnableHttpsInput) {
      appCaproverEnableHttpsInput.checked = remoteApp.hasDefaultSubDomainSsl === true;
    }
    if (appCaproverEnvVarsInput) {
      const envVars = Array.isArray(remoteApp.envVars) ? remoteApp.envVars : [];
      appCaproverEnvVarsInput.value = envVars
        .filter((entry) => entry && typeof entry.key === "string")
        .map((entry) => `${entry.key}=${entry.value ?? ""}`)
        .join("\n");
    }
    if (appCaproverUserInput) {
      appCaproverUserInput.value = typeof gitDeploy?.user === "string" ? gitDeploy.user : "";
    }
    if (appCaproverPasswordInput) {
      appCaproverPasswordInput.value = "";
    }
    if (appCaproverSshKeyInput) {
      appCaproverSshKeyInput.value = "";
    }
    setCaproverWebhook(gitDeploy?.webhookUrl || null);
    if (gitDeploy?.webhookUrl) {
      setCaproverStatus("Git deploy webhook is configured.", "success");
    } else {
      setCaproverStatus("");
    }
  };

  const loadCaproverSetupTargets = async () => {
    try {
      const targets = await fetchCaproverTargets();
      caproverDialogState.targets = targets;
      renderCaproverSetupTargets(targets);
      return targets;
    } catch (error) {
      caproverDialogState.targets = [];
      renderCaproverSetupTargets([]);
      setCaproverStatus(error instanceof Error ? error.message : "Failed to load CapRover targets", "error");
      return [];
    }
  };

  const resetCaproverDialog = () => {
    appCaproverForm?.reset();
    caproverDialogState.appId = null;
    caproverDialogState.targets = [];
    caproverDialogState.deployments = [];
    caproverDialogState.saving = false;
    caproverDialogState.preferredName = "";
    setCaproverStatus("");
    setCaproverWebhook(null);
    if (appCaproverUrl) {
      appCaproverUrl.hidden = true;
      appCaproverUrl.href = "#";
    }
    if (appCaproverSaveButton) {
      appCaproverSaveButton.disabled = false;
      appCaproverSaveButton.textContent = "Register GitHub Deploy";
    }
    renderCaproverDeploymentSummary([]);
    updateCaproverReplicateButton();
  };

  const closeCaproverDialog = () => {
    if (!appCaproverDialog) return;
    if (appCaproverDialog.open) {
      appCaproverDialog.close();
    }
    resetCaproverDialog();
  };

  const openCaproverDialog = async (appId) => {
    if (!appCaproverDialog) return;
    const app = getAppById(appId);
    if (!app) {
      showToast("App not found", { type: "error" });
      return;
    }
    if (!app.webApp) {
      showToast("Only web apps can be linked to CapRover", { type: "error" });
      return;
    }

    resetCaproverDialog();
    caproverDialogState.appId = appId;
    const preferredName = resolveInitialCaproverName(app);
    caproverDialogState.preferredName = preferredName;
    if (appCaproverNameInput) {
      appCaproverNameInput.value = preferredName;
    }
    if (appCaproverTitle) {
      appCaproverTitle.textContent = `CapRover ${app.label?.trim() || String(appId)}`;
    }
    if (appCaproverDialog.open) {
      appCaproverDialog.close();
    }
    appCaproverDialog.showModal();

    const targets = await loadCaproverSetupTargets();
    if (targets.length === 0) {
      setCaproverStatus("No CapRover targets are configured.", "error");
      return;
    }
    await loadCaproverDeploymentSummary();
  };

  const resolveCaproverReplicationName = () => {
    const inputName = appCaproverNameInput?.value?.trim();
    if (inputName) return inputName;
    if (caproverDialogState.preferredName) return caproverDialogState.preferredName;
    const app = getAppById(caproverDialogState.appId);
    return resolveInitialCaproverName(app);
  };

  const selectedCaproverSetupPayload = () => {
    const caproverTarget = appCaproverTargetSelect?.value || "";
    const caproverName = appCaproverNameInput?.value?.trim() || "";
    if (!caproverTarget) {
      throw new Error("Select a CapRover target");
    }
    if (!caproverName) {
      throw new Error("Select a CapRover app");
    }
    return { caproverTarget, caproverName };
  };

  const handleCaproverReplicate = async () => {
    if (caproverDialogState.saving) return;
    const appId = caproverDialogState.appId;
    if (!appId) {
      showToast("No app selected", { type: "error" });
      return;
    }
    const sourceTarget = getCaproverReplicationSource();
    const destinationTarget = getCaproverReplicationDestination();
    const caproverName = resolveCaproverReplicationName();
    if (!sourceTarget || !destinationTarget || sourceTarget === destinationTarget) {
      const message = "Select different source and destination targets.";
      setCaproverStatus(message, "error");
      showToast(message, { type: "error" });
      return;
    }
    const sourceDeployment = caproverDialogState.deployments.find((entry) => entry?.name === sourceTarget);
    if (!sourceDeployment?.linked || sourceDeployment?.error) {
      const message = sourceDeployment?.error
        ? `Cannot copy from ${sourceTarget}: ${sourceDeployment.error}`
        : `Cannot copy from ${sourceTarget}: no registered deployment found.`;
      setCaproverStatus(message, "error");
      showToast(message, { type: "error" });
      return;
    }
    if (!caproverName) {
      const message = "CapRover app name is required.";
      setCaproverStatus(message, "error");
      showToast(message, { type: "error" });
      return;
    }

    caproverDialogState.saving = true;
    updateCaproverReplicateButton();
    if (appCaproverReplicateButton) {
      appCaproverReplicateButton.textContent = "Replicating...";
    }
    setCaproverStatus(`Copying ${caproverName} from ${sourceTarget} to ${destinationTarget}...`);
    try {
      const response = await fetch(`/api/apps/${encodeURIComponent(appId)}/caprover/replicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caproverName,
          sourceTarget,
          destinationTarget,
        }),
      });
      const data = await readJsonResponse(response, "Failed to copy CapRover deployment");
      if (!response.ok) {
        throw new Error(data.error || response.statusText || "Failed to copy CapRover deployment");
      }
      syncCaproverSetupDetails(appId, data);
      void refreshApps({ skipRender: true });
      await loadCaproverDeploymentSummary();
      setCaproverWebhook(data.webhookUrl || data.caprover?.gitDeploy?.webhookUrl || null);
      if (appCaproverUrl && data.caprover?.liveUrl) {
        appCaproverUrl.href = data.caprover.liveUrl;
        appCaproverUrl.textContent = data.caprover.liveUrl;
        appCaproverUrl.hidden = false;
      }
      const sslNote = data.sslError ? ` SSL setup failed: ${data.sslError}` : "";
      const warning = data.warning ? ` ${data.warning}` : "";
      setCaproverStatus(`Replicated to ${destinationTarget}.${sslNote}${warning}`, data.sslError ? "error" : "success");
      showToast(`Copied to ${destinationTarget}`, { type: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to replicate CapRover app";
      setCaproverStatus(message, "error");
      showToast(message, { type: "error" });
    } finally {
      caproverDialogState.saving = false;
      if (appCaproverReplicateButton) {
        appCaproverReplicateButton.textContent = "Copy Deployment";
      }
      updateCaproverReplicateButton();
    }
  };

  const parseCaproverEnvVars = (text) => {
    const envVars = [];
    const lines = String(text || "").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex <= 0) {
        throw new Error(`Invalid environment variable line: ${trimmed}`);
      }
      const key = trimmed.slice(0, equalsIndex).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid environment variable key: ${key}`);
      }
      envVars.push({
        key,
        value: trimmed.slice(equalsIndex + 1),
      });
    }
    return envVars;
  };

  const handleCaproverGitSave = async () => {
    if (caproverDialogState.saving) return;
    const appId = caproverDialogState.appId;
    if (!appId) {
      showToast("No app selected", { type: "error" });
      return;
    }
    let payload;
    try {
      payload = selectedCaproverSetupPayload();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid CapRover app selection";
      setCaproverStatus(message, "error");
      showToast(message, { type: "error" });
      return;
    }

    const repo = appCaproverRepoInput?.value?.trim() || "";
    const branch = appCaproverBranchInput?.value?.trim() || "";
    const user = appCaproverUserInput?.value?.trim() || "";
    const password = appCaproverPasswordInput?.value || "";
    const sshKey = appCaproverSshKeyInput?.value?.trim() || "";
    let envVars = [];
    try {
      envVars = parseCaproverEnvVars(appCaproverEnvVarsInput?.value || "");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid environment variables";
      setCaproverStatus(message, "error");
      showToast(message, { type: "error" });
      return;
    }
    if (!repo || !branch || (!sshKey && (!user || !password))) {
      const message = "Repository, branch, and either SSH key or username/password are required.";
      setCaproverStatus(message, "error");
      showToast(message, { type: "error" });
      return;
    }

    caproverDialogState.saving = true;
    if (appCaproverSaveButton) {
      appCaproverSaveButton.disabled = true;
      appCaproverSaveButton.textContent = "Registering...";
    }
    setCaproverStatus("Registering GitHub deploy...");
    try {
      const response = await fetch(`/api/apps/${encodeURIComponent(appId)}/caprover/git-deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          repo,
          branch,
          user,
          password,
          sshKey,
          envVars,
          enableSsl: appCaproverEnableHttpsInput?.checked === true,
        }),
      });
      const data = await readJsonResponse(response, "Failed to register GitHub deploy");
      if (!response.ok) {
        throw new Error(data.error || response.statusText || "Failed to register GitHub deploy");
      }
      syncCaproverSetupDetails(appId, data);
      void refreshApps({ skipRender: true });
      await loadCaproverDeploymentSummary();
      setCaproverWebhook(data.webhookUrl || data.caprover?.gitDeploy?.webhookUrl || null);
      if (appCaproverUrl && data.caprover?.liveUrl) {
        appCaproverUrl.href = data.caprover.liveUrl;
        appCaproverUrl.textContent = data.caprover.liveUrl;
        appCaproverUrl.hidden = false;
      }
      if (appCaproverPasswordInput) {
        appCaproverPasswordInput.value = "";
      }
      if (appCaproverSshKeyInput) {
        appCaproverSshKeyInput.value = "";
      }
      setCaproverStatus("GitHub deploy registered. Use the webhook URL in GitHub.", "success");
      showToast("CapRover GitHub deploy registered", { type: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save Git deploy settings";
      setCaproverStatus(message, "error");
      showToast(message, { type: "error" });
    } finally {
      caproverDialogState.saving = false;
      if (appCaproverSaveButton) {
        appCaproverSaveButton.disabled = false;
        appCaproverSaveButton.textContent = "Register GitHub Deploy";
      }
    }
  };

  const resetDeployDialog = () => {
    if (appDeployForm) {
      appDeployForm.reset();
    }
    if (appDeployTitle) {
      appDeployTitle.textContent = "Deploy to CapRover";
    }
    if (appDeployStatus) {
      appDeployStatus.hidden = true;
    }
    if (appDeployMessage) {
      appDeployMessage.textContent = "";
      appDeployMessage.className = "";
    }
    if (appDeployUrl) {
      appDeployUrl.hidden = true;
      appDeployUrl.href = "#";
    }
    setDeployConfirmButtonState("Deploy", false);
    deployDialogState.appId = null;
    deployDialogState.deploying = false;
    deployDialogState.targets = [];
    if (appDeployTargetSelect) {
      appDeployTargetSelect.disabled = false;
    }
    if (appDeployEnableHttpsInput) {
      appDeployEnableHttpsInput.disabled = false;
    }
    setDeployDialogCompletionState(false);
  };

  const closeDeployDialog = () => {
    if (!appDeployDialog) return;
    if (appDeployDialog.open) {
      appDeployDialog.close();
    }
    resetDeployDialog();
  };

  const openDeployDialog = async (appId) => {
    if (!appDeployDialog) return;

    const app = getAppById(appId);
    if (!app) {
      showToast("App not found", { type: "error" });
      return;
    }

    if (!app.webApp) {
      showToast("Only web apps can be deployed to CapRover", { type: "error" });
      return;
    }

    resetDeployDialog();
    deployDialogState.appId = appId;

    // Set dialog title with app name
    if (appDeployTitle) {
      const appName = app.label?.trim() || String(appId);
      appDeployTitle.textContent = `Deploy ${appName}`;
    }

    if (appDeployNameInput) {
      appDeployNameInput.value = resolveInitialCaproverName(app);
    }

    const targets = await loadCaproverTargets();
    if (targets.length === 0 && appDeployMessage && appDeployStatus) {
      appDeployStatus.hidden = false;
      appDeployMessage.textContent = "No CapRover targets are configured.";
      appDeployMessage.className = "wm-deploy-error";
      setDeployConfirmButtonState("Deploy", true);
    }

    if (appDeployDialog.open) {
      appDeployDialog.close();
    }
    appDeployDialog.showModal();
    appDeployNameInput?.focus();
  };

  const deriveCaproverNameFromLabel = (label) => {
    if (!label || typeof label !== "string") return "";
    return label
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .replace(/^[^a-z]+/, "")
      .slice(0, 50);
  };

  const handleDeploySubmit = async (event) => {
    event.preventDefault();
    if (deployDialogState.deploying) return;
    if (deployDialogState.completed) {
      closeDeployDialog();
      return;
    }

    const appId = deployDialogState.appId;
    if (!appId) {
      showToast("No app selected for deployment", { type: "error" });
      return;
    }

    const caproverName = appDeployNameInput?.value?.trim() ?? "";
    if (!caproverName) {
      showToast("CapRover app name is required", { type: "error" });
      appDeployNameInput?.focus();
      return;
    }

    const caproverTarget = appDeployTargetSelect?.value || "all";
    const enableHttps = appDeployEnableHttpsInput?.checked === true;

    // Validate format
    if (!/^[a-z][a-z0-9-]*$/.test(caproverName)) {
      showToast("Invalid CapRover name format", { type: "error" });
      appDeployNameInput?.focus();
      return;
    }

    deployDialogState.deploying = true;
    setDeployConfirmButtonState("Deploying…", true);
    if (appDeployStatus) {
      appDeployStatus.hidden = false;
    }
    if (appDeployMessage) {
      appDeployMessage.textContent = "Deploying to CapRover…";
      appDeployMessage.className = "wm-deploy-pending";
    }
    if (appDeployUrl) {
      appDeployUrl.hidden = true;
    }

    try {
      const response = await fetch(`/api/apps/${encodeURIComponent(appId)}/deploy-to-caprover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caproverName, caproverTarget, enableHttps }),
      });

      let data;
      try {
        data = await response.json();
      } catch {
        // Response wasn't valid JSON
        throw new Error(response.ok ? "Invalid server response" : `Deployment failed: ${response.statusText || response.status}`);
      }

      if (!response.ok) {
        throw new Error(data.error || response.statusText || "Deployment failed");
      }

      // Success
      syncDeployedAppDetails(appId, data);
      void refreshApps({ skipRender: true });
      if (appDeployMessage) {
        appDeployMessage.textContent = formatDeployResultMessage(data);
        appDeployMessage.className = "wm-deploy-success";
      }
      if (appDeployUrl && data.liveUrl) {
        appDeployUrl.href = data.liveUrl;
        appDeployUrl.textContent = data.liveUrl;
        appDeployUrl.hidden = false;
      }
      setDeployDialogCompletionState(true);
      setDeployConfirmButtonState("Close", false);
      showToast("Deployed to CapRover", { type: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Deployment failed";
      if (appDeployMessage) {
        appDeployMessage.textContent = message;
        appDeployMessage.className = "wm-deploy-error";
      }
      setDeployConfirmButtonState("Retry", false);
      showToast(message, { type: "error" });
    } finally {
      deployDialogState.deploying = false;
    }
  };

  appDeployForm?.addEventListener("submit", handleDeploySubmit);

  appDeployCancelButton?.addEventListener("click", (event) => {
    event.preventDefault();
    closeDeployDialog();
  });

  appDeployDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDeployDialog();
  });

  appDeployDialog?.addEventListener("close", () => {
    resetDeployDialog();
  });

  appCaproverForm?.addEventListener("submit", (event) => {
    event.preventDefault();
  });

  appCaproverTargetSelect?.addEventListener("change", () => {
    updateCaproverReplicateButton();
    applyDeploymentForSelectedTarget();
  });

  appCaproverCopySourceSelect?.addEventListener("change", () => {
    updateCaproverReplicateButton();
  });

  appCaproverNameInput?.addEventListener("change", () => {
    void loadCaproverDeploymentSummary();
  });

  appCaproverRefreshButton?.addEventListener("click", (event) => {
    event.preventDefault();
    void loadCaproverDeploymentSummary();
  });

  appCaproverReplicateButton?.addEventListener("click", (event) => {
    event.preventDefault();
    void handleCaproverReplicate();
  });

  appCaproverSaveButton?.addEventListener("click", (event) => {
    event.preventDefault();
    void handleCaproverGitSave();
  });

  appCaproverCopyWebhookButton?.addEventListener("click", async (event) => {
    event.preventDefault();
    const value = appCaproverWebhookInput?.value || "";
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showToast("Webhook URL copied", { type: "success" });
    } catch {
      appCaproverWebhookInput?.focus();
      appCaproverWebhookInput?.select();
      showToast("Select the webhook URL to copy it", { type: "info" });
    }
  });

  appCaproverCancelButton?.addEventListener("click", (event) => {
    event.preventDefault();
    closeCaproverDialog();
  });

  appCaproverDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeCaproverDialog();
  });

  appCaproverDialog?.addEventListener("close", () => {
    resetCaproverDialog();
  });

  return {
    openAppDialog,
    closeAppDialog,
    openAppLogsDialog,
    refreshAppLogs,
    resetAppDialog,
    openDeployDialog,
    openCaproverDialog,
  };
};
