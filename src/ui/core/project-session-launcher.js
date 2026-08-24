const projectSessionCounters = new Map();

export function getNextProjectSessionName(project) {
  const projectKey = project?.id || project?.directoryPath || project?.name || "project";
  const current = projectSessionCounters.get(projectKey) ?? 0;
  const next = current + 1;
  projectSessionCounters.set(projectKey, next);
  const projectName = typeof project?.name === "string" && project.name.trim().length > 0
    ? project.name.trim()
    : "Session";
  return `${projectName}-${next}`;
}

export async function launchProjectSession({
  project,
  state,
  launchSession,
  showToast,
}) {
  if (!project?.directoryPath || typeof launchSession !== "function") {
    showToast?.("Project is missing a launch directory.", { type: "error" });
    return false;
  }

  const agentId = state?.config?.defaultAgent ?? "codex";
  const sessionName = getNextProjectSessionName(project);

  try {
    await launchSession(agentId, project.directoryPath, sessionName, null, { openInNewTab: true });
    return true;
  } catch (error) {
    console.error("Failed to launch project session:", error);
    showToast?.("Failed to launch session", { type: "error" });
    return false;
  }
}
