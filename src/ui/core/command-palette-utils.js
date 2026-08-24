export function createCommandItem(input) {
  return {
    group: input.group,
    groupLabel: input.groupLabel,
    id: input.id,
    title: input.title,
    subtitle: input.subtitle ?? "",
    action: input.action,
    shortcutKey: input.shortcutKey ?? "",
    targetId: input.targetId ?? "",
    searchText: input.searchText ?? "",
  };
}

const ACTIVE_SESSION_STATUSES = new Set(["starting", "running"]);

function getSessionEntrySubtitle(session, fallback = "Session") {
  return session?.workingDirectory ?? session?.directory ?? fallback;
}

export function isCommandPaletteActiveSession(session) {
  return ACTIVE_SESSION_STATUSES.has(session?.status) || session?.agentRuntimeStatus === "running";
}

export function getCommandPaletteSessionEntries(storedEntries, sessions, getDisplayName) {
  const sessionList = Array.isArray(sessions) ? sessions : [];
  const resolveDisplayName = typeof getDisplayName === "function"
    ? getDisplayName
    : (session) => session?.name ?? session?.id ?? "Session";
  const sessionById = new Map(
    sessionList
      .filter((session) => typeof session?.id === "string" && session.id)
      .map((session) => [session.id, session]),
  );
  const seen = new Set();
  const entries = [];

  (Array.isArray(storedEntries) ? storedEntries : []).forEach((entry) => {
    const id = typeof entry?.id === "string" ? entry.id : "";
    if (!id || seen.has(id)) return;
    const session = sessionById.get(id);
    if (!session) return;
    seen.add(id);
    entries.push({
      id,
      title: resolveDisplayName(session),
      subtitle: getSessionEntrySubtitle(session),
    });
  });

  sessionList.forEach((session) => {
    const id = typeof session?.id === "string" ? session.id : "";
    if (!id || seen.has(id) || !isCommandPaletteActiveSession(session)) return;
    seen.add(id);
    entries.push({
      id,
      title: resolveDisplayName(session),
      subtitle: getSessionEntrySubtitle(session),
    });
  });

  return entries;
}

export function getRecentLaunchProjects(projects, limit = 9) {
  if (!Array.isArray(projects)) return [];
  const boundedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 9;
  return projects
    .filter((project) => project?.id && project?.directoryPath)
    .slice(0, boundedLimit);
}

export function createCommandPaletteArchiveItem({
  group = "recent-session",
  groupLabel = "Recent Sessions",
} = {}) {
  return createCommandItem({
    group,
    groupLabel,
    id: `${group}:archive`,
    title: "Archive",
    subtitle: "Filter archived sessions and resume from disk",
    action: "archive-sessions",
    searchText: "archive archived sessions resume disk history",
  });
}

export function createCommandPaletteLaunchItems(projects) {
  const modalItem = createCommandItem({
    group: "session-launch",
    groupLabel: "Launch New Session",
    id: "launch:new-session-modal",
    title: "New Session",
    subtitle: "Open the full launch modal",
    action: "open-session-modal",
    shortcutKey: "0",
    searchText: "new session launch modal custom directory",
  });

  const projectItems = getRecentLaunchProjects(projects).map((project, index) => createCommandItem({
    group: "session-launch",
    groupLabel: "Launch New Session",
    id: `launch-project:${project.id}`,
    title: project.name || project.directoryPath,
    subtitle: project.directoryPath,
    action: "launch-project-session",
    shortcutKey: String(index + 1),
    targetId: project.id,
    searchText: [
      project.id,
      project.name,
      project.directoryPath,
      project.worktreeName,
    ].filter(Boolean).join(" "),
  }));

  return [
    modalItem,
    ...projectItems,
    createCommandPaletteArchiveItem({
      group: "session-archive",
      groupLabel: "Archived Sessions",
    }),
  ];
}

export function createCommandPaletteQuickItems() {
  return [
    createCommandItem({
      group: "shortcut",
      groupLabel: "Shortcuts",
      id: "quick:home",
      title: "Home",
      subtitle: "Return to the main session screen",
      action: "home",
      shortcutKey: "0",
      searchText: "home dashboard sessions main",
    }),
    createCommandItem({
      group: "shortcut",
      groupLabel: "Shortcuts",
      id: "quick:new-session",
      title: "Sessions",
      subtitle: "Launch an agent session",
      action: "new-session",
      shortcutKey: "1",
      searchText: "agent launch start new session",
    }),
    createCommandItem({
      group: "shortcut",
      groupLabel: "Shortcuts",
      id: "quick:running-apps",
      title: "Apps",
      subtitle: "Manage running app processes",
      action: "running-apps",
      shortcutKey: "2",
      searchText: "apps processes restart",
    }),
    createCommandItem({
      group: "shortcut",
      groupLabel: "Shortcuts",
      id: "quick:running-pipelines",
      title: "Pipelines",
      subtitle: "Inspect active pipeline runs",
      action: "running-pipelines",
      shortcutKey: "3",
      searchText: "pipelines runs workflows restart",
    }),
    createCommandItem({
      group: "shortcut",
      groupLabel: "Shortcuts",
      id: "quick:files",
      title: "Files",
      subtitle: "Browse workspace files",
      action: "files",
      shortcutKey: "4",
      searchText: "files browser workspace docs",
    }),
  ];
}

export function rememberRecentItem(items, item, limit = 6) {
  if (!item?.id) return Array.isArray(items) ? items : [];
  const existing = Array.isArray(items) ? items : [];
  const next = [
    { ...item, updatedAt: item.updatedAt ?? new Date().toISOString() },
    ...existing.filter((entry) => entry?.id !== item.id),
  ];
  return next.slice(0, limit);
}

export function filterCommandPaletteItems(items, query) {
  const terms = String(query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return Array.isArray(items) ? items : [];
  return (Array.isArray(items) ? items : []).filter((item) => {
    const haystack = [
      item?.title,
      item?.subtitle,
      item?.groupLabel,
      item?.searchText,
    ].filter(Boolean).join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function getNextCommandPaletteActiveId(items, activeId, delta) {
  const list = Array.isArray(items) ? items.filter((item) => item?.id) : [];
  if (list.length === 0) return "";
  const direction = delta < 0 ? -1 : 1;
  const currentIndex = list.findIndex((item) => item.id === activeId);
  if (currentIndex < 0) {
    return direction < 0 ? list[list.length - 1].id : list[0].id;
  }
  const nextIndex = (currentIndex + direction + list.length) % list.length;
  return list[nextIndex].id;
}

export function getCommandPaletteKeyboardItems(items) {
  const list = Array.isArray(items) ? items.filter((item) => item?.id) : [];
  const nonShortcutItems = list.filter((item) => item.group !== "shortcut");
  return nonShortcutItems.length > 0 ? nonShortcutItems : list;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
