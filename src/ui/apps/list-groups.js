import { getAppStatusValue } from "./table.js";

export function partitionAppsByRuntimeStatus(apps) {
  const groups = {
    running: [],
    stopped: [],
  };

  if (!Array.isArray(apps)) {
    return groups;
  }

  apps.forEach((app) => {
    const group = getAppStatusValue(app) === "running" ? groups.running : groups.stopped;
    group.push(app);
  });

  return groups;
}

export function renderAppsListGroups({ apps, renderTable, renderCards }) {
  const groups = partitionAppsByRuntimeStatus(apps);
  const container = document.createElement("div");
  container.className = "wm-apps-groups";
  container.dataset.testid = "apps-runtime-groups";

  container.append(
    renderAppsListGroup({
      id: "running",
      title: "Running Apps",
      apps: groups.running,
      emptyMessage: "No apps are currently running.",
      renderTable,
      renderCards,
    }),
    renderAppsListGroup({
      id: "stopped",
      title: "Stopped Apps",
      apps: groups.stopped,
      emptyMessage: "No stopped apps match the current filter.",
      renderTable,
      renderCards,
    }),
  );

  return container;
}

function renderAppsListGroup({ id, title, apps, emptyMessage, renderTable, renderCards }) {
  const group = document.createElement("details");
  group.className = "wm-apps-group";
  group.open = true;
  group.dataset.testid = `apps-group-${id}`;

  const summary = document.createElement("summary");
  summary.className = "wm-apps-group__summary";
  summary.setAttribute("aria-label", `${title}, ${apps.length} app${apps.length === 1 ? "" : "s"}`);
  summary.dataset.testid = `apps-group-${id}-toggle`;

  const heading = document.createElement("span");
  heading.className = "wm-apps-group__title";
  heading.textContent = title;

  const count = document.createElement("span");
  count.className = "wm-apps-group__count";
  count.textContent = String(apps.length);
  count.setAttribute("aria-hidden", "true");
  summary.append(heading, count);

  const content = document.createElement("div");
  content.className = "wm-apps-group__content";
  content.setAttribute("role", "region");
  content.setAttribute("aria-label", title);
  content.dataset.testid = `apps-group-${id}-content`;

  if (apps.length === 0) {
    const empty = document.createElement("p");
    empty.className = "wm-apps-empty";
    empty.textContent = emptyMessage;
    content.append(empty);
  } else {
    content.append(renderTable(apps, id), renderCards(apps, id));
  }

  group.append(summary, content);
  return group;
}
