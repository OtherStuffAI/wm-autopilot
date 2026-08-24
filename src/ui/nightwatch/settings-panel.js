/**
 * Night Watch Settings Panel
 *
 * Admin panel for viewing the fixed Night Watch timer configuration
 * and recent report cards.
 */

import {
  fetchNightWatchConfig,
  updateNightWatchConfig,
  fetchNightWatchReports,
  deleteNightWatchReport,
} from "./api.js";
import { createStatusBadge, formatTimestamp } from "./helpers.js";

export function initNightWatchSettingsPanel({ state, render, showToast, createCollapsibleCard }) {
  async function loadConfig() {
    try {
      const data = await fetchNightWatchConfig();
      state.nightwatch.config.intervalMinutes = Number(data.intervalMinutes) || 5;
      state.nightwatch.config.prompt = data.prompt || "Any progress?";
      state.nightwatch.config.maxCycles = data.maxCycles || 21;
      state.nightwatch.config.maxCycleOptions = data.maxCycleOptions || [6, 21, 256];
    } catch (err) {
      console.warn("[nightwatch] Failed to load config:", err);
    }
  }

  async function loadReports() {
    if (state.nightwatch.reportsLoading) return;
    state.nightwatch.reportsLoading = true;
    try {
      const data = await fetchNightWatchReports();
      state.nightwatch.reports = data.reports || [];
      state.nightwatch.reportsInitialized = true;
    } catch (err) {
      console.warn("[nightwatch] Failed to load reports:", err);
    } finally {
      state.nightwatch.reportsLoading = false;
    }
  }

  async function ensureLoaded() {
    if (!state.nightwatch.reportsInitialized) {
      await loadConfig();
      await loadReports();
    }
  }

  function renderPanel() {
    const nw = state.nightwatch;
    const { card, body } = createCollapsibleCard({
      title: "Night Watchman",
      className: "wm-nightwatch-settings",
      collapsed: state.settingsPanels.nightwatchCollapsed,
      onToggle(collapsed) {
        state.settingsPanels.nightwatchCollapsed = collapsed;
      },
    });

    const info = document.createElement("div");
    info.style.cssText =
      "display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 1rem; opacity: 0.85;";

    const cadence = document.createElement("p");
    cadence.textContent = `When enabled, Night Watch sends "${nw.config.prompt}" every ${nw.config.intervalMinutes} minutes.`;
    cadence.style.margin = "0";

    const limitGroup = document.createElement("div");
    limitGroup.className = "wm-form-group";
    const limitLabel = document.createElement("label");
    limitLabel.textContent = "Max Check-ins";
    limitLabel.style.fontWeight = "600";
    const limitSelect = document.createElement("select");
    limitSelect.className = "wm-select";
    for (const count of nw.config.maxCycleOptions || [6, 21, 256]) {
      const opt = document.createElement("option");
      opt.value = String(count);
      opt.textContent = String(count);
      if (count === nw.config.maxCycles) opt.selected = true;
      limitSelect.append(opt);
    }
    limitSelect.addEventListener("change", async () => {
      try {
        const data = await updateNightWatchConfig({ maxCycles: Number(limitSelect.value) });
        nw.config.maxCycles = data.maxCycles;
        render();
        showToast(`Max check-ins set to ${data.maxCycles}`);
      } catch (err) {
        showToast(`Failed to update max check-ins: ${err.message}`, { type: "error" });
      }
    });
    limitGroup.append(limitLabel, limitSelect);

    info.append(cadence, limitGroup);
    body.append(info);

    const reportsTitle = document.createElement("h3");
    reportsTitle.textContent = "Report Cards";
    reportsTitle.style.cssText = "margin: 0.75rem 0 0.5rem; font-size: 0.9rem;";
    body.append(reportsTitle);

    if (nw.reportsLoading) {
      const loading = document.createElement("p");
      loading.textContent = "Loading reports...";
      loading.style.opacity = "0.6";
      body.append(loading);
    } else if (nw.reports.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No report cards yet.";
      empty.style.opacity = "0.6";
      body.append(empty);
    } else {
      const list = document.createElement("div");
      list.style.cssText = "display: flex; flex-direction: column; gap: 0.5rem;";
      for (const report of nw.reports) {
        list.append(renderReportCard(report));
      }
      body.append(list);
    }

    return card;
  }

  function renderReportCard(report) {
    const item = document.createElement("div");
    item.style.cssText = `
      border: 1px solid var(--border-color, #333);
      border-radius: 6px;
      padding: 0.6rem 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    `;

    const header = document.createElement("div");
    header.style.cssText = "display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;";
    header.append(createStatusBadge(report.status));

    if (report.inputMode === "raw") {
      const rawTag = document.createElement("span");
      rawTag.textContent = "RAW";
      rawTag.style.cssText =
        "display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 0.65rem; font-weight: 700; color: #fff; background: #8b5cf6; letter-spacing: 0.05em;";
      header.append(rawTag);
    }

    if (report.sessionName) {
      const link = document.createElement("a");
      link.href = `/live/${report.sessionId}`;
      link.textContent = report.sessionName;
      link.style.cssText =
        "font-weight: 600; text-decoration: none; color: var(--accent-color, #7dd3fc);";
      header.append(link);
    } else {
      const idSpan = document.createElement("span");
      idSpan.textContent = report.sessionId.slice(0, 8);
      idSpan.style.fontWeight = "600";
      header.append(idSpan);
    }

    const meta = document.createElement("span");
    meta.textContent = `${report.cycleCount} cycles \u00b7 ${formatTimestamp(report.createdAt)}`;
    meta.style.cssText = "font-size: 0.75rem; opacity: 0.6; margin-left: auto;";
    header.append(meta);

    item.append(header);

    const summary = document.createElement("p");
    summary.textContent = report.summary;
    summary.style.cssText = "margin: 0; font-size: 0.85rem; line-height: 1.4;";
    item.append(summary);

    if (report.reasoning) {
      const reasoning = document.createElement("p");
      reasoning.textContent = report.reasoning;
      reasoning.style.cssText =
        "margin: 0.25rem 0 0; font-size: 0.8rem; line-height: 1.3; opacity: 0.7; font-style: italic; border-left: 2px solid rgba(255,255,255,0.15); padding-left: 0.5rem;";
      item.append(reasoning);
    }

    const actions = document.createElement("div");
    actions.style.cssText = "display: flex; justify-content: flex-end;";
    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.textContent = "Dismiss";
    dismissBtn.className = "wm-btn wm-btn--sm";
    dismissBtn.addEventListener("click", async () => {
      try {
        await deleteNightWatchReport(report.id);
        state.nightwatch.reports = state.nightwatch.reports.filter((r) => r.id !== report.id);
        render();
        showToast("Report dismissed");
      } catch (err) {
        showToast(`Failed to dismiss: ${err.message}`, { type: "error" });
      }
    });
    actions.append(dismissBtn);
    item.append(actions);

    return item;
  }

  return { renderPanel, ensureLoaded };
}
