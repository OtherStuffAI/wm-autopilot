import {
  getActivePipelineRuns,
  getPipelineRunDisplayName,
  showRunningPipelinesModal,
} from "../pipelines/running-pipelines-modal.js";
import { PIPELINE_AGENT_OUTPUT_FORMATTING_FLAG_KEY } from "../pipelines/agent-output-format.js";
import { formatRunMeta, statusLabel } from "../pipelines/view-utils.js";

const DEFAULT_RECENT_HISTORY_LIMIT = 5;

function getPipelineDefinitionLabel(run) {
  const value = run?.definitionSlug ?? run?.definitionId ?? "";
  return String(value || "pipeline");
}

async function fetchPipelineRunSummaries() {
  const { fetchPipelineRuns } = await import("../pipelines/api.js");
  return fetchPipelineRuns();
}

function toHomePipelineRow(run) {
  return {
    id: String(run.id),
    name: getPipelineRunDisplayName(run),
    status: String(run.status ?? ""),
    statusLabel: statusLabel(run.status),
    definitionLabel: getPipelineDefinitionLabel(run),
    meta: formatRunMeta(run),
  };
}

export function getHomePipelineSections(runs, options = {}) {
  const source = Array.isArray(runs) ? runs.filter((run) => run?.id) : [];
  const activeIds = new Set(getActivePipelineRuns(source).map((run) => String(run.id)));
  const recentHistoryLimit = Math.max(
    0,
    Number(options.recentHistoryLimit ?? DEFAULT_RECENT_HISTORY_LIMIT) || 0,
  );

  return {
    active: source
      .filter((run) => activeIds.has(String(run.id)))
      .map(toHomePipelineRow),
    history: source
      .filter((run) => !activeIds.has(String(run.id)))
      .slice(0, recentHistoryLimit)
      .map(toHomePipelineRow),
  };
}

export function getHomeRunningPipelineRows(runs) {
  return getHomePipelineSections(runs).active;
}

function getTotalRowCount(sections) {
  return sections.active.length + sections.history.length;
}

function getPipelineBadgeLabel(sections) {
  const activeCount = sections.active.length;
  const historyCount = sections.history.length;
  return `${activeCount} active pipeline${activeCount === 1 ? "" : "s"}, ${historyCount} recent historical pipeline${historyCount === 1 ? "" : "s"}`;
}

function getSectionRows(sections) {
  return [
    {
      title: "Running",
      empty: "No pipeline runs are currently active.",
      rows: sections.active,
    },
    {
      title: "Recent History",
      empty: "No historical pipeline runs have been recorded yet.",
      rows: sections.history,
    },
  ];
}

export function getHomePipelineRows(runs, options = {}) {
  const sections = getHomePipelineSections(runs, options);
  return getSectionRows(sections)
    .flatMap((section) => section.rows.map((row) => ({
      section: section.title,
      ...row,
    })));
}

export function createRunningPipelinesSection({ showToast, isFeatureEnabledForViewer = () => false, collapsible = true } = {}) {
  const state = {
    sections: {
      active: [],
      history: [],
    },
    loading: false,
    initialized: false,
    error: null,
  };

  let refreshTimer = null;

  const card = document.createElement("section");
  card.className = "wm-card wm-home-running-pipelines wm-home-quadrant";
  card.dataset.collapsible = String(collapsible);
  card.dataset.testid = "home-running-pipelines";
  card.setAttribute("aria-labelledby", "home-running-pipelines-title");

  const header = document.createElement(collapsible ? "button" : "div");
  if (collapsible) {
    header.type = "button";
  }
  header.className = "wm-home-section-header wm-home-running-pipelines__header wm-home-quadrant__header";
  header.setAttribute("aria-expanded", "true");

  const titleWrap = document.createElement("div");
  titleWrap.className = "wm-home-running-pipelines__title wm-home-quadrant__title";

  const title = document.createElement("h2");
  title.id = "home-running-pipelines-title";
  title.textContent = "Pipelines";

  const badge = document.createElement("span");
  badge.className = "wm-home-running-pipelines__badge wm-home-quadrant__badge";
  badge.textContent = "0";
  badge.setAttribute("aria-label", "0 active pipelines, 0 recent historical pipelines");

  titleWrap.append(title, badge);

  const actions = document.createElement("div");
  actions.className = "wm-home-section-actions";

  const openListButton = document.createElement("button");
  openListButton.type = "button";
  openListButton.className = "wm-button secondary";
  openListButton.textContent = "Details";
  openListButton.dataset.testid = "home-running-pipelines-details";
  openListButton.setAttribute("aria-label", "Open pipeline run details");
  openListButton.addEventListener("click", () => {
    showRunningPipelinesModal({
      showToast,
      agentOutputFormattingEnabled: Boolean(
        isFeatureEnabledForViewer(PIPELINE_AGENT_OUTPUT_FORMATTING_FLAG_KEY),
      ),
    });
  });

  const pipelinesLink = document.createElement("a");
  pipelinesLink.className = "wm-button secondary";
  pipelinesLink.href = "/pipelines/runs";
  pipelinesLink.textContent = "Open Pipelines";
  pipelinesLink.dataset.testid = "home-running-pipelines-open";
  pipelinesLink.setAttribute("aria-label", "Open pipeline runs");

  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "wm-button secondary";
  refreshButton.textContent = "Refresh";
  refreshButton.dataset.testid = "home-running-pipelines-refresh";
  refreshButton.setAttribute("aria-label", "Refresh pipelines");
  refreshButton.addEventListener("click", () => {
    void loadRuns({ showErrors: true });
  });

  const collapseIcon = document.createElement("span");
  collapseIcon.className = "wm-home-quadrant__collapse";
  collapseIcon.setAttribute("aria-hidden", "true");
  collapseIcon.textContent = "▼";

  actions.append(openListButton, pipelinesLink, refreshButton);
  header.append(titleWrap);
  if (collapsible) {
    header.append(collapseIcon);
  }

  const content = document.createElement("div");
  content.className = "wm-home-running-pipelines__content wm-home-quadrant__content";
  content.setAttribute("aria-live", "polite");

  if (collapsible) {
    header.addEventListener("click", () => {
      const collapsed = card.dataset.collapsed === "true";
      setCollapsed(!collapsed);
    });
  }

  function setCollapsed(collapsed) {
    if (collapsed) {
      card.dataset.collapsed = "true";
      content.hidden = true;
      header.setAttribute("aria-expanded", "false");
      return;
    }
    delete card.dataset.collapsed;
    content.hidden = false;
    header.setAttribute("aria-expanded", "true");
  }

  card.append(header, actions, content);

  function scheduleRefresh() {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (!card.isConnected) return;
      void loadRuns({ silent: true });
    }, 15000);
  }

  function render() {
    const totalRows = getTotalRowCount(state.sections);
    badge.textContent = String(totalRows);
    badge.setAttribute("aria-label", getPipelineBadgeLabel(state.sections));
    refreshButton.disabled = state.loading;
    refreshButton.textContent = state.loading ? "Refreshing..." : "Refresh";

    content.innerHTML = "";

    if (state.loading && !state.initialized) {
      content.append(createStatus("Loading pipelines..."));
      return;
    }

    if (state.error) {
      content.append(createStatus(state.error, "error"));
      return;
    }

    if (totalRows === 0) {
      content.append(createStatus("No pipeline runs have been recorded yet."));
      return;
    }

    getSectionRows(state.sections).forEach((section) => {
      content.append(createRunSection(section));
    });
  }

  function createStatus(message, type = "") {
    const status = document.createElement("p");
    status.className = "wm-home-running-pipelines__status";
    if (type) {
      status.dataset.state = type;
      status.setAttribute("role", "alert");
    }
    status.textContent = message;
    return status;
  }

  function createRunSection(section) {
    const wrapper = document.createElement("section");
    wrapper.className = "wm-home-running-pipelines__section";
    wrapper.setAttribute("aria-label", section.title);

    const heading = document.createElement("h3");
    heading.className = "wm-home-running-pipelines__section-title";
    heading.textContent = section.title;
    wrapper.append(heading);

    if (section.rows.length === 0) {
      wrapper.append(createStatus(section.empty));
      return wrapper;
    }

    const list = document.createElement("div");
    list.className = "wm-home-running-pipelines__list";
    list.dataset.testid = section.title === "Running"
      ? "home-running-pipelines-list"
      : "home-pipeline-history-list";

    section.rows.forEach((row) => {
      list.append(createRunItem(row));
    });

    wrapper.append(list);
    return wrapper;
  }

  function createRunItem(row) {
    const item = document.createElement("article");
    item.className = "wm-home-running-pipelines__item";
    item.dataset.testid = "home-running-pipeline-row";

    const link = document.createElement("a");
    link.className = "wm-home-running-pipelines__main";
    link.href = `/pipelines/runs/${encodeURIComponent(row.id)}`;
    link.setAttribute("aria-label", `Open pipeline run ${row.name}`);

    const name = document.createElement("strong");
    name.textContent = row.name;

    const meta = document.createElement("small");
    meta.textContent = `${row.definitionLabel} - ${row.meta}`;

    link.append(name, meta);

    const status = document.createElement("span");
    status.className = "wm-pipeline-status-chip";
    status.dataset.status = row.status;
    status.textContent = row.statusLabel;

    const code = document.createElement("code");
    code.textContent = row.id.slice(0, 8);

    item.append(link, status, code);
    return item;
  }

  async function loadRuns({ silent = false, showErrors = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    state.error = null;
    if (!silent) render();
    try {
      const payload = await fetchPipelineRunSummaries();
      state.sections = getHomePipelineSections(payload?.runs ?? []);
      state.initialized = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load running pipelines.";
      state.error = message;
      if (showErrors) {
        showToast?.(message, { type: "error" });
      }
    } finally {
      state.loading = false;
      render();
      scheduleRefresh();
    }
  }

  render();
  void loadRuns();

  return {
    element: card,
    refresh: loadRuns,
  };
}
