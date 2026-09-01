/**
 * App card rendering module.
 *
 * Provides renderWingmanCard and renderAppCard as extracted from app.js.
 * Uses dependency injection so callers supply all external references.
 *
 * @param {object} deps
 * @param {() => object} deps.appsStore              - lazy accessor for Alpine apps store
 * @param {object} deps.APP_STATUS_LABELS            - map of status key → display label
 * @param {(logs: string[]) => HTMLElement} deps.renderLogPreview - renders a log preview <pre>
 * @param {Function} deps.launchSession              - launches an agent session
 * @param {Function} deps.fetchAppLogsApi            - fetches app logs from API
 * @param {Function} deps.importAppDotenvApi         - imports app root .env into managed env
 * @param {Function} deps.removeApp                  - removes an app by id
 * @param {Function} deps.removeWapp                 - removes a WApp assignment by id
 * @param {object} deps.state                        - global UI state
 * @param {Function} deps.formatAppTimestamp         - formats a timestamp for display
 * @param {Function} deps.formatAppActionLabel       - formats an action label
 * @param {Function} deps.formatWebAppUrl            - formats a web app URL from port
 * @param {Function} deps.deriveAppWindowName        - derives a tmux window name
 * @param {Function} deps.appendVariableUrlRow       - appends a URL meta row
 * @param {Function} deps.appendVariablePubkeyRow    - appends a pubkey meta row
 * @param {Function} deps.isAppActionDisabled        - checks whether an app action is disabled
 * @param {Function} deps.triggerAppAction           - triggers app actions (start/stop/restart/setup/clear-logs)
 * @param {Function} deps.triggerRestart             - restarts Wingman and recreates active sessions
 * @param {Function} deps.runSystemCleanup           - triggers system cleanup
 * @param {Function} deps.openIdentityLoginDialog    - opens the identity login dialog
 * @param {Function} deps.showToast                  - displays toast feedback
 * @param {Function} deps.buildSessionOrigin         - builds session origin metadata
 * @param {Function} deps.openAppLogsDialog          - opens the app logs dialog
 * @param {Function} deps.openDeployDialog           - opens the deploy dialog
 * @param {Function} deps.openCaproverDialog         - opens the CapRover setup dialog
 * @param {Function} deps.openAppDialog              - opens the app edit dialog
 * @param {Function} deps.refreshApps                - refreshes app cards
 */
import { openConfirmDialog } from "../common/dialog-prompts.js";
import { getAppFipsUrl } from "./table.js";

export function initAppCards(deps) {
  const {
    appsStore,
    APP_STATUS_LABELS,
    renderLogPreview,
    launchSession,
    fetchAppLogsApi,
    importAppDotenvApi,
    removeApp,
    removeWapp,
    state,
    formatAppTimestamp,
    formatAppActionLabel,
    formatWebAppUrl,
    deriveAppWindowName,
    appendVariableUrlRow,
    appendVariablePubkeyRow,
    isAppActionDisabled,
    triggerAppAction,
    triggerRestart,
    runSystemCleanup,
    openIdentityLoginDialog,
    showToast,
    buildSessionOrigin,
    openAppLogsDialog,
    openDeployDialog,
    openCaproverDialog,
    openAppDialog,
    refreshApps,
  } = deps;

  const renderWingmanCard = (app) => {
    const card = document.createElement("section");
    card.className = "wm-card wm-app-card wm-app-card-core";

    const header = document.createElement("div");
    header.className = "wm-app-card__header";
    const title = document.createElement("h3");
    title.textContent = app.label ?? "Wingman Server";
    header.append(title);

    const statusBadge = document.createElement("span");
    statusBadge.className = "wm-app-status";
    const restartInProgress = appsStore().system.restart.inProgress;
    const cleanupState = appsStore().system.cleanup;
    const cleanupRunning = cleanupState.running;
    const statusValue = restartInProgress ? "restarting" : app?.status?.status ?? "running";
    statusBadge.dataset.state = statusValue;
    statusBadge.textContent = APP_STATUS_LABELS[statusValue] ?? statusValue;
    header.append(statusBadge);
    card.append(header);

    const statusInfo = document.createElement("div");
    statusInfo.className = "wm-app-status-info";

    if (appsStore().system.restart.error) {
      const errorLine = document.createElement("p");
      errorLine.className = "wm-app-status-error";
      errorLine.textContent = appsStore().system.restart.error;
      statusInfo.append(errorLine);
    } else if (restartInProgress) {
      const progressLine = document.createElement("p");
      const sessionCount = Array.isArray(appsStore().system.restart.marker?.sessionIds)
        ? appsStore().system.restart.marker.sessionIds.length
        : null;
      progressLine.textContent = `Restart in progress… ${sessionCount ?? 0} stopped session${sessionCount === 1 ? "" : "s"} will resume natively or start fresh.`;
      statusInfo.append(progressLine);
    } else if (appsStore().system.restart.outcome) {
      const outcome = appsStore().system.restart.outcome;
      const summaryLine = document.createElement("p");
      const resumed = Array.isArray(outcome.resumedSessions) ? outcome.resumedSessions.length : 0;
      const fresh = Array.isArray(outcome.freshSessions) ? outcome.freshSessions.length : 0;
      summaryLine.textContent = `Last restart recreated ${outcome.restored} session${outcome.restored === 1 ? "" : "s"}: ${resumed} resumed and ${fresh} fresh (${formatAppTimestamp(outcome.timestamp)}).`;
      statusInfo.append(summaryLine);
      if (outcome.failed?.length > 0) {
        const failedLine = document.createElement("p");
        failedLine.textContent = `Unable to rehydrate ${outcome.failed.length} session${
          outcome.failed.length === 1 ? "" : "s"
        }.`;
        statusInfo.append(failedLine);
      }
    } else {
      const idleLine = document.createElement("p");
      idleLine.textContent = "Restart stops active agent processes, then resumes their native sessions or starts fresh replacements.";
      statusInfo.append(idleLine);
    }

    const marker = appsStore().system.restart.marker;
    if (marker?.createdAt && !restartInProgress) {
      const scheduledLine = document.createElement("p");
      scheduledLine.textContent = `Last restart request: ${formatAppTimestamp(marker.createdAt)}`;
      statusInfo.append(scheduledLine);
    }

    const cleanupResult =
      cleanupState.result && typeof cleanupState.result === "object" ? cleanupState.result : null;
    if (cleanupState.error) {
      const cleanupError = document.createElement("p");
      cleanupError.className = "wm-app-status-error";
      cleanupError.textContent = cleanupState.error;
      statusInfo.append(cleanupError);
    }
    if (cleanupResult && typeof cleanupResult.timestamp === "string") {
      const sessionsSummary =
        cleanupResult.sessions && typeof cleanupResult.sessions === "object"
          ? cleanupResult.sessions
          : {};
      const appsSummary =
        cleanupResult.apps && typeof cleanupResult.apps === "object"
          ? cleanupResult.apps
          : {};
      const deletedSessions =
        typeof sessionsSummary.deleted === "number" ? sessionsSummary.deleted : 0;
      const removedApps = typeof appsSummary.removed === "number" ? appsSummary.removed : 0;
      const summaryLine = document.createElement("p");
      summaryLine.textContent = `Last cleanup removed ${deletedSessions} session${deletedSessions === 1 ? "" : "s"} and ${removedApps} app${removedApps === 1 ? "" : "s"} (${formatAppTimestamp(cleanupResult.timestamp)}).`;
      statusInfo.append(summaryLine);
      const sessionFailures =
        typeof sessionsSummary.failed === "number" ? sessionsSummary.failed : 0;
      const appFailures = typeof appsSummary.failed === "number" ? appsSummary.failed : 0;
      const totalFailures = sessionFailures + appFailures;
      if (totalFailures > 0) {
        const failureLine = document.createElement("p");
        failureLine.textContent = `${totalFailures} cleanup action${totalFailures === 1 ? "" : "s"} reported errors.`;
        statusInfo.append(failureLine);
      }
      if (cleanupResult.preservedCoreApp) {
        const preservedLine = document.createElement("p");
        preservedLine.textContent = "Wingman core app preserved during cleanup.";
        statusInfo.append(preservedLine);
      }
    }

    card.append(statusInfo);

    card.append(renderLogPreview(app.logs));

    const actions = document.createElement("div");
    actions.className = "wm-app-actions";

    const viewLogsButton = document.createElement("button");
    viewLogsButton.type = "button";
    viewLogsButton.className = "wm-button secondary";
    viewLogsButton.textContent = "View Logs";
    viewLogsButton.dataset.appCardOpensDialog = "true";
    viewLogsButton.addEventListener("click", () => void openAppLogsDialog(app.id));
    actions.append(viewLogsButton);

    const restartButton = document.createElement("button");
    restartButton.type = "button";
    restartButton.className = "wm-button";
    restartButton.dataset.testid = "restart-autopilot";
    restartButton.setAttribute("aria-label", "Restart Autopilot and recover active agent sessions");
    restartButton.textContent = restartInProgress ? "Restarting…" : "Restart Wingman";
    restartButton.disabled =
      appsStore().system.restart.submitting || restartInProgress || cleanupRunning;
    restartButton.addEventListener("click", async () => {
      if (restartButton.disabled) return;
      const confirmed = await openConfirmDialog({
        title: "Restart Autopilot?",
        description: "Active agent processes will stop. Sessions will resume natively when possible and otherwise start fresh. In-flight turns may be interrupted.",
        confirmLabel: "Restart Autopilot",
        testId: "restart-autopilot-confirmation",
      });
      if (!confirmed) return;
      restartButton.disabled = true;
      restartButton.textContent = "Restarting…";
      const success = await triggerRestart();
      if (!success) {
        restartButton.disabled = false;
        restartButton.textContent = "Restart Wingman";
      }
    });
    actions.append(restartButton);

    if (state.identity.isAdmin) {
      const cleanupButton = document.createElement("button");
      cleanupButton.type = "button";
      cleanupButton.className = "wm-button danger";
      cleanupButton.dataset.testid = "stop-agents-and-apps";
      cleanupButton.setAttribute("aria-label", "Stop all running agents and apps");
      const cleanupDisabled = cleanupRunning || restartInProgress || appsStore().system.restart.submitting;
      cleanupButton.textContent = cleanupRunning ? "Stopping…" : "Stop Agents & Apps";
      cleanupButton.disabled = cleanupDisabled;
      cleanupButton.addEventListener("click", async () => {
        if (cleanupButton.disabled) return;
        const confirmed = window.confirm(
          "Stop all running agents and apps? Active pipeline workers will be stopped.",
        );
        if (!confirmed) return;
        cleanupButton.disabled = true;
        cleanupButton.textContent = "Stopping…";
        const success = await runSystemCleanup();
        if (!success) {
          cleanupButton.disabled = false;
          cleanupButton.textContent = "Stop Agents & Apps";
        }
      });
      actions.append(cleanupButton);
    }

    card.append(actions);
    return card;
  };

  const renderAppCard = (app) => {
    const card = document.createElement("section");
    card.className = "wm-card wm-app-card";
    card.dataset.appId = app.id;
    if (app.id === "wingman-core") {
      card.classList.add("wm-app-card-core");
    }

    const header = document.createElement("div");
    header.className = "wm-app-card__header";
    const title = document.createElement("h3");
    title.textContent = app.label ?? app.id;
    header.append(title);

    const statusBadge = document.createElement("span");
    statusBadge.className = "wm-app-status";
    const statusValue = app?.status?.status ?? "idle";
    statusBadge.dataset.state = statusValue;
    statusBadge.textContent = APP_STATUS_LABELS[statusValue] ?? statusValue;
    header.append(statusBadge);
    card.append(header);

    const meta = document.createElement("div");
    meta.className = "wm-app-meta";

    const rootRow = document.createElement("div");
    rootRow.className = "wm-app-meta-row";
    const rootLabel = document.createElement("span");
    rootLabel.className = "wm-app-meta-label";
    rootLabel.textContent = "Root";
    const rootValue = document.createElement("code");
    rootValue.textContent = app.root;
    rootValue.title = app.root;
    rootRow.append(rootLabel, rootValue);
    meta.append(rootRow);

    const isWebApp = Boolean(app.webApp);
    const activeWapps = Array.isArray(app.wapps)
      ? app.wapps.filter((wapp) => wapp && (wapp.recordState ?? "active") === "active")
      : [];
    const webAppRow = document.createElement("div");
    webAppRow.className = "wm-app-meta-row";
    const webAppLabel = document.createElement("span");
    webAppLabel.className = "wm-app-meta-label";
    webAppLabel.textContent = "Web app";
    const webAppValue = document.createElement("span");
    webAppValue.className = "wm-app-meta-value";
    webAppValue.textContent = isWebApp ? "Yes" : "No";
    webAppRow.append(webAppLabel, webAppValue);
    meta.append(webAppRow);

    const autoStartRow = document.createElement("div");
    autoStartRow.className = "wm-app-meta-row";
    const autoStartLabel = document.createElement("span");
    autoStartLabel.className = "wm-app-meta-label";
    autoStartLabel.textContent = "Auto-start";
    const autoStartValue = document.createElement("span");
    autoStartValue.className = "wm-app-meta-value";
    autoStartValue.textContent = app.autoStart ? "Yes" : "No";
    autoStartRow.append(autoStartLabel, autoStartValue);
    meta.append(autoStartRow);

    const envCount = Array.isArray(app.env) ? app.env.length : 0;
    if (envCount > 0) {
      const envRow = document.createElement("div");
      envRow.className = "wm-app-meta-row";
      const envLabel = document.createElement("span");
      envLabel.className = "wm-app-meta-label";
      envLabel.textContent = "Env";
      const envValue = document.createElement("span");
      envValue.className = "wm-app-meta-value";
      envValue.textContent = `${envCount} managed variable${envCount === 1 ? "" : "s"}`;
      envRow.append(envLabel, envValue);
      meta.append(envRow);
    }

    if (isWebApp) {
      const portRow = document.createElement("div");
      portRow.className = "wm-app-meta-row";
      const portLabel = document.createElement("span");
      portLabel.className = "wm-app-meta-label";
      portLabel.textContent = "Port";
      const portValue = document.createElement("span");
      portValue.className = "wm-app-meta-value";
      if (typeof app.webAppPort === "number") {
        const code = document.createElement("code");
        code.textContent = String(app.webAppPort);
        portValue.append(code);
        const href = app.subdomainUrl
          ? null
          : typeof app.webAppUrl === "string" && app.webAppUrl.length > 0
            ? app.webAppUrl
            : formatWebAppUrl(app.webAppPort);
        if (href) {
          const link = document.createElement("a");
          link.href = href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = "Open";
          portValue.append(link);
        }
      } else {
        portValue.textContent = "Assigning…";
      }
      portRow.append(portLabel, portValue);
      meta.append(portRow);

      // Subdomain URL row (alias-based routing)
      if (app.subdomainUrl) {
        const subdomainRow = document.createElement("div");
        subdomainRow.className = "wm-app-meta-row";
        const subdomainLabel = document.createElement("span");
        subdomainLabel.className = "wm-app-meta-label";
        subdomainLabel.textContent = "Open App";
        const subdomainValue = document.createElement("span");
        subdomainValue.className = "wm-app-meta-value";
        const subdomainLink = document.createElement("a");
        subdomainLink.href = app.subdomainUrl;
        subdomainLink.target = "_blank";
        subdomainLink.rel = "noopener noreferrer";
        // For path-based URLs, show just the alias; for full URLs, show the URL
        const displayText = app.subdomainUrl.startsWith("/host/")
          ? app.subdomainAlias ?? app.subdomainUrl
          : app.subdomainUrl;
        subdomainLink.textContent = displayText;
        subdomainValue.append(subdomainLink);
        subdomainRow.append(subdomainLabel, subdomainValue);
        meta.append(subdomainRow);
      }

      const fipsUrl = getAppFipsUrl(app);
      if (fipsUrl) {
        const fipsRow = document.createElement("div");
        fipsRow.className = "wm-app-meta-row";
        const fipsLabel = document.createElement("span");
        fipsLabel.className = "wm-app-meta-label";
        fipsLabel.textContent = "FIPS";
        const fipsValue = document.createElement("span");
        fipsValue.className = "wm-app-meta-value";
        const fipsLink = document.createElement("a");
        fipsLink.href = fipsUrl;
        fipsLink.target = "_blank";
        fipsLink.rel = "noopener noreferrer";
        fipsLink.textContent = fipsUrl;
        fipsLink.setAttribute("aria-label", `Open ${app.label ?? app.id} over FIPS`);
        fipsLink.dataset.testid = "app-card-fips-link";
        fipsValue.append(fipsLink);
        fipsRow.append(fipsLabel, fipsValue);
        meta.append(fipsRow);
      }

      if (typeof app.caproverLiveUrl === "string" && app.caproverLiveUrl.length > 0) {
        const deployRow = document.createElement("div");
        deployRow.className = "wm-app-meta-row";
        const deployLabel = document.createElement("span");
        deployLabel.className = "wm-app-meta-label";
        deployLabel.textContent = "Deploy URL";
        const deployValue = document.createElement("span");
        deployValue.className = "wm-app-meta-value";
        const deployLink = document.createElement("a");
        deployLink.href = app.caproverLiveUrl;
        deployLink.target = "_blank";
        deployLink.rel = "noopener noreferrer";
        deployLink.textContent = app.caproverLiveUrl;
        deployValue.append(deployLink);
        deployRow.append(deployLabel, deployValue);
        meta.append(deployRow);
      }
    }

    if (activeWapps.length > 0) {
      const wappRow = document.createElement("div");
      wappRow.className = "wm-app-meta-row";
      const wappLabel = document.createElement("span");
      wappLabel.className = "wm-app-meta-label";
      wappLabel.textContent = activeWapps.length === 1 ? "WApp" : "WApps";
      const wappValue = document.createElement("span");
      wappValue.className = "wm-app-meta-value";
      wappValue.textContent = activeWapps
        .map((wapp) => wapp.title || wapp.id)
        .filter(Boolean)
        .join(", ");
      wappRow.append(wappLabel, wappValue);
      meta.append(wappRow);
    }

    const windowRow = document.createElement("div");
    windowRow.className = "wm-app-meta-row";
    const windowValue = document.createElement("code");
    const windowName = app.tmuxWindow ?? app.tmuxSession ?? deriveAppWindowName(app.label ?? "", app.root ?? "");
    windowValue.textContent = windowName;
    windowValue.title = windowName;
    windowRow.append(windowValue);
    meta.append(windowRow);

    appendVariableUrlRow(meta, app.logs);
    appendVariablePubkeyRow(meta, app.logs);

    card.append(meta);

    if (app.notes) {
      const notes = document.createElement("p");
      notes.className = "wm-app-notes";
      notes.textContent = app.notes;
      card.append(notes);
    }

    const statusInfo = document.createElement("div");
    statusInfo.className = "wm-app-status-info";

    const lastAction = document.createElement("p");
    lastAction.textContent = `Last Action: ${
      app.status?.lastAction ? formatAppActionLabel(app.status.lastAction) : "—"
    }`;
    statusInfo.append(lastAction);

    const updatedLine = document.createElement("p");
    updatedLine.textContent = `Updated: ${formatAppTimestamp(app.status?.updatedAt ?? null)}`;
    statusInfo.append(updatedLine);

    const messageLine = document.createElement("p");
    messageLine.textContent = `Message: ${app.status?.message ?? "—"}`;
    statusInfo.append(messageLine);

    if (typeof app.status?.lastExitCode === "number") {
      const exitLine = document.createElement("p");
      exitLine.textContent = `Last Exit Code: ${app.status.lastExitCode}`;
      statusInfo.append(exitLine);
    }

    card.append(statusInfo);

    card.append(renderLogPreview(app.logs));

    const isCoreApp = app.id === "wingman-core";

    const controls = document.createElement("div");
    controls.className = "wm-app-actions";

    if (!isCoreApp && app.availableScripts?.start) {
      const startButton = document.createElement("button");
      startButton.type = "button";
      startButton.className = "wm-button";
      startButton.textContent = "Start";
      startButton.disabled = isAppActionDisabled(app, "start");
      startButton.addEventListener("click", async () => {
        if (startButton.disabled) return;
        startButton.disabled = true;
        const success = await triggerAppAction(app.id, "start");
        if (!success && startButton.isConnected) {
          startButton.disabled = false;
        }
      });
      controls.append(startButton);
    }

    if (!isCoreApp) {
      const stopButton = document.createElement("button");
      stopButton.type = "button";
      stopButton.className = "wm-button secondary";
      stopButton.textContent = "Stop";
      stopButton.disabled = isAppActionDisabled(app, "stop");
      stopButton.addEventListener("click", async () => {
        if (stopButton.disabled) return;
        stopButton.disabled = true;
        const success = await triggerAppAction(app.id, "stop");
        if (!success && stopButton.isConnected) {
          stopButton.disabled = false;
        }
      });
      controls.append(stopButton);
    }

    const restartButton = document.createElement("button");
    restartButton.type = "button";
    restartButton.className = "wm-button";
    restartButton.textContent = "Restart";
    restartButton.disabled = isAppActionDisabled(app, "restart");
    restartButton.addEventListener("click", async () => {
      if (restartButton.disabled) return;
      restartButton.disabled = true;
      const success = await triggerAppAction(app.id, "restart");
      if (!success && restartButton.isConnected) {
        restartButton.disabled = false;
      }
    });
    controls.append(restartButton);

    if (!isCoreApp && app.availableScripts?.setup) {
      const setupButton = document.createElement("button");
      setupButton.type = "button";
      setupButton.className = "wm-button secondary";
      setupButton.textContent = "Setup";
      setupButton.disabled = isAppActionDisabled(app, "setup");
      setupButton.addEventListener("click", async () => {
        if (setupButton.disabled) return;
        setupButton.disabled = true;
        const success = await triggerAppAction(app.id, "setup");
        if (!success && setupButton.isConnected) {
          setupButton.disabled = false;
        }
      });
      controls.append(setupButton);
    }

    const editWithAiButton = document.createElement("button");
    editWithAiButton.type = "button";
    editWithAiButton.className = "wm-button secondary";
    editWithAiButton.textContent = "Edit with AI";
    editWithAiButton.addEventListener("click", async () => {
      if (editWithAiButton.disabled) return;
      if (!state.identity.authenticated) {
        openIdentityLoginDialog();
        return;
      }
      const workingDirectory = typeof app.root === "string" ? app.root : "";
      if (!workingDirectory) {
        showToast("App root directory is unavailable for this app.", { type: "warning" });
        return;
      }
      const agentId = state.config?.defaultAgent ?? "codex";
      const configuredAgents = Array.isArray(state.config?.agents) ? state.config.agents : null;
      if (configuredAgents && !configuredAgents.some((agent) => agent && typeof agent.id === "string" && agent.id === agentId)) {
        showToast(`${agentId} agent is not available. Update your configuration and try again.`, {
          type: "error",
        });
        return;
      }
      const appName =
        typeof app.label === "string" && app.label.trim().length > 0 ? app.label.trim() : String(app.id ?? "app");
      const sessionName = `editing ${appName}`;
      const origin = buildSessionOrigin({
        type: "app",
        id: app.id ?? "",
        url: app.id !== undefined && app.id !== null ? `/apps/${app.id}` : undefined,
        label: app.label,
      });
      const originalLabel = editWithAiButton.textContent;
      editWithAiButton.disabled = true;
      editWithAiButton.textContent = "Launching…";
      try {
        await launchSession(agentId, workingDirectory, sessionName, undefined, { openInNewTab: true, origin });
      } finally {
        if (editWithAiButton.isConnected) {
          editWithAiButton.disabled = false;
          editWithAiButton.textContent = originalLabel ?? "Edit with AI";
        }
      }
    });
    controls.append(editWithAiButton);

    // Fix with AI button - fetches logs and launches Claude with them pre-filled
    const fixWithAiButton = document.createElement("button");
    fixWithAiButton.type = "button";
    fixWithAiButton.className = "wm-button secondary";
    fixWithAiButton.textContent = "Fix with AI";
    fixWithAiButton.addEventListener("click", async () => {
      if (fixWithAiButton.disabled) return;
      if (!state.identity.authenticated) {
        openIdentityLoginDialog();
        return;
      }
      const workingDirectory = typeof app.root === "string" ? app.root : "";
      if (!workingDirectory) {
        showToast("App root directory is unavailable for this app.", { type: "warning" });
        return;
      }
      const agentId = state.config?.defaultAgent ?? "codex";
      const configuredAgents = Array.isArray(state.config?.agents) ? state.config.agents : null;
      if (configuredAgents && !configuredAgents.some((agent) => agent && typeof agent.id === "string" && agent.id === agentId)) {
        showToast(`${agentId} agent is not available. Update your configuration and try again.`, {
          type: "error",
        });
        return;
      }

      const originalLabel = fixWithAiButton.textContent;
      fixWithAiButton.disabled = true;
      fixWithAiButton.textContent = "Loading logs…";

      try {
        // Fetch the app's recent logs
        const logsResponse = await fetchAppLogsApi(app.id, 100);
        const logs = logsResponse?.logs ?? [];

        // Build log file paths
        const logFilePaths = [];
        if (app.logsDir && app.pm2Name) {
          logFilePaths.push(`${app.logsDir}/${app.pm2Name}-out.log`);
          logFilePaths.push(`${app.logsDir}/${app.pm2Name}-error.log`);
        }

        // Build the initial prompt
        const appName =
          typeof app.label === "string" && app.label.trim().length > 0 ? app.label.trim() : String(app.id ?? "app");
        const sessionName = `fixing ${appName}`;

        let initialPrompt = `Please review these logs and the full log file if needed. I would like assistance debugging this issue and approaches to fix. Please ask questions if you need more context.\n\n`;

        if (logs.length > 0) {
          initialPrompt += `## Recent Logs (tail)\n\`\`\`\n${logs.join("\n")}\n\`\`\`\n\n`;
        } else {
          initialPrompt += `## Recent Logs\nNo recent logs available.\n\n`;
        }

        if (logFilePaths.length > 0) {
          initialPrompt += `## Full Log Files\n${logFilePaths.map((p) => `- ${p}`).join("\n")}\n`;
        }

        const origin = buildSessionOrigin({
          type: "app",
          id: app.id ?? "",
          url: app.id !== undefined && app.id !== null ? `/apps/${app.id}` : undefined,
          label: app.label,
        });

        fixWithAiButton.textContent = "Launching…";
        await launchSession(agentId, workingDirectory, sessionName, undefined, {
          openInNewTab: true,
          origin,
          initialPrompt,
        });
      } catch (error) {
        console.error("Fix with AI failed:", error);
        showToast("Failed to launch Fix with AI. Check console for details.", { type: "error" });
      } finally {
        if (fixWithAiButton.isConnected) {
          fixWithAiButton.disabled = false;
          fixWithAiButton.textContent = originalLabel ?? "Fix with AI";
        }
      }
    });
    controls.append(fixWithAiButton);

    // CapRover deployments (web apps only)
    if (isWebApp) {
      const deployButton = document.createElement("button");
      deployButton.type = "button";
      deployButton.className = "wm-button secondary";
      deployButton.textContent = "Deployments";
      deployButton.dataset.appCardOpensDialog = "true";
      deployButton.addEventListener("click", () => {
        openCaproverDialog(app.id);
      });
      controls.append(deployButton);
    }

    card.append(controls);

    const linkBar = document.createElement("div");
    linkBar.className = "wm-app-links";

    const viewLogsLink = document.createElement("a");
    viewLogsLink.href = "#";
    viewLogsLink.textContent = "View logs";
    viewLogsLink.addEventListener("click", (event) => {
      event.preventDefault();
      void openAppLogsDialog(app.id);
    });
    linkBar.append(viewLogsLink);

    const clearLogsLink = document.createElement("a");
    clearLogsLink.href = "#";
    clearLogsLink.textContent = "Clear logs";
    clearLogsLink.setAttribute("aria-label", `Clear logs for ${app.label ?? app.id}`);
    clearLogsLink.dataset.testid = "app-card-clear-logs";
    let clearingLogs = false;
    clearLogsLink.addEventListener("click", async (event) => {
      event.preventDefault();
      if (clearingLogs) {
        return;
      }
      const appName = app.label ?? app.id;
      const confirmed = await openConfirmDialog({
        title: "Clear App Logs",
        description: `Clear logs for "${appName}"?`,
        confirmLabel: "Clear",
        testId: "app-card-clear-logs-dialog",
      });
      if (!confirmed) {
        return;
      }
      clearingLogs = true;
      clearLogsLink.setAttribute("aria-disabled", "true");
      const success = await triggerAppAction(app.id, "clear-logs");
      if (!success && clearLogsLink.isConnected) {
        clearingLogs = false;
        clearLogsLink.removeAttribute("aria-disabled");
      }
    });
    linkBar.append(clearLogsLink);

    const editLink = document.createElement("a");
    editLink.href = "#";
    editLink.textContent = "Edit";
    editLink.addEventListener("click", (event) => {
      event.preventDefault();
      openAppDialog(app.id);
    });
    linkBar.append(editLink);

    if (typeof importAppDotenvApi === "function") {
      const importEnvLink = document.createElement("a");
      importEnvLink.href = "#";
      importEnvLink.textContent = "Import .env";
      importEnvLink.dataset.testid = "app-card-import-dotenv";
      importEnvLink.addEventListener("click", async (event) => {
        event.preventDefault();
        if (importEnvLink.getAttribute("aria-disabled") === "true") return;
        const confirmed = await openConfirmDialog({
          title: "Import .env",
          description: "Read the app root .env file and copy its variables into this app card's managed environment.",
          confirmLabel: "Import .env",
          testId: "import-dotenv-dialog",
        });
        if (!confirmed) return;
        importEnvLink.setAttribute("aria-disabled", "true");
        try {
          const result = await importAppDotenvApi(app.id, { filename: ".env", overwrite: true });
          if (!result?.success) {
            showToast(result?.error || "Failed to import .env", { type: "error" });
            return;
          }
          const keys = Array.isArray(result.data?.imported?.keys) ? result.data.imported.keys : [];
          const warningCount = Array.isArray(result.data?.imported?.warnings) ? result.data.imported.warnings.length : 0;
          const suffix = warningCount > 0 ? `; ${warningCount} warning${warningCount === 1 ? "" : "s"}` : "";
          showToast(`Imported ${keys.length} env variable${keys.length === 1 ? "" : "s"}${suffix}`, { type: "success" });
          await refreshApps?.({ skipRender: false });
        } catch (error) {
          showToast(error instanceof Error ? error.message : "Failed to import .env", { type: "error" });
        } finally {
          if (importEnvLink.isConnected) {
            importEnvLink.removeAttribute("aria-disabled");
          }
        }
      });
      linkBar.append(importEnvLink);
    }

    activeWapps.forEach((wapp) => {
      const removeWappLink = document.createElement("a");
      removeWappLink.href = "#";
      removeWappLink.textContent = activeWapps.length === 1 ? "Remove WApp" : `Remove WApp: ${wapp.title || wapp.id}`;
      removeWappLink.dataset.testid = "app-card-remove-wapp";
      removeWappLink.addEventListener("click", async (event) => {
        event.preventDefault();
        if (removeWappLink.getAttribute("aria-disabled") === "true") return;
        removeWappLink.setAttribute("aria-disabled", "true");
        const success = await removeWapp(wapp);
        if (!success && removeWappLink.isConnected) {
          removeWappLink.removeAttribute("aria-disabled");
        }
      });
      linkBar.append(removeWappLink);
    });

    const removeLink = document.createElement("a");
    removeLink.href = "#";
    removeLink.textContent = "Remove";
    removeLink.addEventListener("click", (event) => {
      event.preventDefault();
      removeApp(app.id);
    });
    linkBar.append(removeLink);

    card.append(linkBar);

    return card;
  };

  return { renderAppCard, renderWingmanCard };
}
