/**
 * Npub Projects UI module
 * Renders the list of auto-tracked projects for the current user
 */

/** @typedef {{ id: string, npub: string, directoryPath: string, name: string, isCustomName: boolean, worktreeName: string | null, appId: string | null, taskBoardUrl: string | null, lastUsedAt: string, sessionCount: number }} NpubProject */

/** @type {{ items: NpubProject[], loading: boolean, error: string | null }} */
const npubProjectsState = {
  items: [],
  loading: false,
  error: null,
};

const fetchNpubProjects = async () => {
  npubProjectsState.loading = true;
  npubProjectsState.error = null;

  try {
    const response = await fetch("/api/npub-projects", { credentials: "include" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    const data = await response.json();
    npubProjectsState.items = Array.isArray(data.projects) ? data.projects : [];
  } catch (error) {
    npubProjectsState.error = error instanceof Error ? error.message : String(error);
    npubProjectsState.items = [];
  } finally {
    npubProjectsState.loading = false;
  }
};

const updateProjectName = async (projectId, name) => {
  try {
    const response = await fetch(`/api/npub-projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    const data = await response.json();
    const index = npubProjectsState.items.findIndex((p) => p.id === projectId);
    if (index !== -1 && data.project) {
      npubProjectsState.items[index] = data.project;
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const resetProjectName = async (projectId) => {
  try {
    const response = await fetch(`/api/npub-projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resetName: true }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    const data = await response.json();
    const index = npubProjectsState.items.findIndex((p) => p.id === projectId);
    if (index !== -1 && data.project) {
      npubProjectsState.items[index] = data.project;
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const updateProjectTaskBoardUrl = async (projectId, taskBoardUrl) => {
  try {
    const response = await fetch(`/api/npub-projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskBoardUrl: taskBoardUrl || null }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    const data = await response.json();
    const index = npubProjectsState.items.findIndex((p) => p.id === projectId);
    if (index !== -1 && data.project) {
      npubProjectsState.items[index] = data.project;
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const deleteProject = async (projectId) => {
  try {
    const response = await fetch(`/api/npub-projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    npubProjectsState.items = npubProjectsState.items.filter((p) => p.id !== projectId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const createProject = async (directoryPath, name) => {
  try {
    const body = { directoryPath };
    if (name && name.trim()) {
      body.name = name.trim();
    }
    const response = await fetch("/api/npub-projects", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    if (data.project) {
      npubProjectsState.items.unshift(data.project);
    }
    return { success: true, project: data.project };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const formatRelativeTime = (isoString) => {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
  return `${Math.floor(diffDays / 365)} years ago`;
};

/**
 * Renders a single project row
 * @param {NpubProject} project
 * @param {() => void} onUpdate - callback when project is updated
 */
const renderProjectRow = (project, onUpdate) => {
  const row = document.createElement("div");
  row.className = "wm-npub-project-row";
  row.dataset.projectId = project.id;

  const info = document.createElement("div");
  info.className = "wm-npub-project-info";

  const nameContainer = document.createElement("div");
  nameContainer.className = "wm-npub-project-name-container";

  const nameSpan = document.createElement("span");
  nameSpan.className = "wm-npub-project-name";
  nameSpan.textContent = project.name;

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "wm-npub-project-name-input";
  nameInput.value = project.name;
  nameInput.style.display = "none";

  nameContainer.append(nameSpan, nameInput);

  // Show app badge if project has a linked app
  if (project.appId) {
    const appBadge = document.createElement("span");
    appBadge.className = "wm-npub-project-app-badge";
    appBadge.textContent = "App";
    appBadge.title = "This project has a linked app";
    nameContainer.append(appBadge);
  }

  const pathSpan = document.createElement("span");
  pathSpan.className = "wm-npub-project-path";
  pathSpan.textContent = project.directoryPath;
  pathSpan.title = project.directoryPath;

  const meta = document.createElement("span");
  meta.className = "wm-npub-project-meta";
  meta.textContent = `${project.sessionCount} session${project.sessionCount !== 1 ? "s" : ""} · ${formatRelativeTime(project.lastUsedAt)}`;

  // Task board URL row
  const boardRow = document.createElement("div");
  boardRow.className = "wm-npub-project-board-row";

  if (project.taskBoardUrl) {
    const boardLink = document.createElement("a");
    boardLink.className = "wm-npub-project-board-link";
    boardLink.href = project.taskBoardUrl;
    boardLink.target = "_blank";
    boardLink.rel = "noopener noreferrer";
    // Show a short label: hostname + path
    try {
      const u = new URL(project.taskBoardUrl);
      boardLink.textContent = u.host + u.pathname + u.search;
    } catch {
      boardLink.textContent = project.taskBoardUrl;
    }
    boardLink.title = project.taskBoardUrl;
    boardRow.append(boardLink);
  }

  const boardEditBtn = document.createElement("button");
  boardEditBtn.type = "button";
  boardEditBtn.className = "wm-npub-project-board-edit";
  boardEditBtn.textContent = project.taskBoardUrl ? "Edit" : "Add Board";
  boardEditBtn.title = "Set task board URL";
  boardRow.append(boardEditBtn);

  const boardInput = document.createElement("input");
  boardInput.type = "url";
  boardInput.className = "wm-npub-project-board-input";
  boardInput.placeholder = "https://tasks.example.invalid/t/project/todo/kanban";
  boardInput.value = project.taskBoardUrl || "";
  boardInput.style.display = "none";

  const boardSaveBtn = document.createElement("button");
  boardSaveBtn.type = "button";
  boardSaveBtn.className = "wm-button small primary";
  boardSaveBtn.textContent = "Save";
  boardSaveBtn.style.display = "none";

  const boardCancelBtn = document.createElement("button");
  boardCancelBtn.type = "button";
  boardCancelBtn.className = "wm-button small secondary";
  boardCancelBtn.textContent = "Cancel";
  boardCancelBtn.style.display = "none";

  const boardClearBtn = document.createElement("button");
  boardClearBtn.type = "button";
  boardClearBtn.className = "wm-button small danger";
  boardClearBtn.textContent = "Clear";
  boardClearBtn.style.display = "none";

  boardRow.append(boardInput, boardSaveBtn, boardCancelBtn);
  if (project.taskBoardUrl) boardRow.append(boardClearBtn);

  boardEditBtn.addEventListener("click", () => {
    boardEditBtn.style.display = "none";
    boardInput.style.display = "inline-block";
    boardSaveBtn.style.display = "inline-block";
    boardCancelBtn.style.display = "inline-block";
    if (project.taskBoardUrl) boardClearBtn.style.display = "inline-block";
    boardInput.focus();
  });

  boardCancelBtn.addEventListener("click", () => {
    boardInput.value = project.taskBoardUrl || "";
    boardInput.style.display = "none";
    boardSaveBtn.style.display = "none";
    boardCancelBtn.style.display = "none";
    boardClearBtn.style.display = "none";
    boardEditBtn.style.display = "inline-block";
  });

  const saveBoardUrl = async (url) => {
    boardSaveBtn.disabled = true;
    boardSaveBtn.textContent = "Saving...";
    const result = await updateProjectTaskBoardUrl(project.id, url);
    if (result.success) {
      onUpdate();
    } else {
      alert(result.error || "Failed to update task board URL");
      boardSaveBtn.disabled = false;
      boardSaveBtn.textContent = "Save";
    }
  };

  boardSaveBtn.addEventListener("click", () => saveBoardUrl(boardInput.value.trim()));

  boardClearBtn.addEventListener("click", () => saveBoardUrl(""));

  boardInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") boardSaveBtn.click();
    else if (e.key === "Escape") boardCancelBtn.click();
  });

  info.append(nameContainer, pathSpan, meta, boardRow);

  const actions = document.createElement("div");
  actions.className = "wm-npub-project-actions";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "wm-button small secondary";
  editBtn.textContent = "Rename";
  editBtn.title = "Rename this project";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "wm-button small primary";
  saveBtn.textContent = "Save";
  saveBtn.style.display = "none";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "wm-button small secondary";
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.display = "none";

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "wm-button small secondary";
  resetBtn.textContent = "Reset";
  resetBtn.title = "Reset to auto-generated name";
  resetBtn.style.display = project.isCustomName ? "inline-block" : "none";

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "wm-button small danger";
  deleteBtn.textContent = "Remove";
  deleteBtn.title = "Remove from tracking";

  const enterEditMode = () => {
    nameSpan.style.display = "none";
    nameInput.style.display = "inline-block";
    nameInput.value = project.name;
    nameInput.focus();
    nameInput.select();
    editBtn.style.display = "none";
    saveBtn.style.display = "inline-block";
    cancelBtn.style.display = "inline-block";
    resetBtn.style.display = "none";
    deleteBtn.style.display = "none";
  };

  const exitEditMode = () => {
    nameSpan.style.display = "inline";
    nameInput.style.display = "none";
    editBtn.style.display = "inline-block";
    saveBtn.style.display = "none";
    cancelBtn.style.display = "none";
    resetBtn.style.display = project.isCustomName ? "inline-block" : "none";
    deleteBtn.style.display = "inline-block";
  };

  editBtn.addEventListener("click", enterEditMode);
  cancelBtn.addEventListener("click", exitEditMode);

  saveBtn.addEventListener("click", async () => {
    const newName = nameInput.value.trim();
    if (!newName) {
      alert("Project name cannot be empty");
      return;
    }
    if (newName === project.name) {
      exitEditMode();
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    const result = await updateProjectName(project.id, newName);
    if (result.success) {
      onUpdate();
    } else {
      alert(result.error || "Failed to update project name");
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  });

  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      saveBtn.click();
    } else if (e.key === "Escape") {
      exitEditMode();
    }
  });

  resetBtn.addEventListener("click", async () => {
    if (!confirm("Reset to the auto-generated name?")) return;
    resetBtn.disabled = true;
    resetBtn.textContent = "Resetting...";
    const result = await resetProjectName(project.id);
    if (result.success) {
      onUpdate();
    } else {
      alert(result.error || "Failed to reset project name");
      resetBtn.disabled = false;
      resetBtn.textContent = "Reset";
    }
  });

  deleteBtn.addEventListener("click", async () => {
    if (!confirm(`Remove "${project.name}" from tracking? This won't delete any files.`)) return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = "Removing...";
    const result = await deleteProject(project.id);
    if (result.success) {
      onUpdate();
    } else {
      alert(result.error || "Failed to remove project");
      deleteBtn.disabled = false;
      deleteBtn.textContent = "Remove";
    }
  });

  actions.append(editBtn, saveBtn, cancelBtn, resetBtn, deleteBtn);
  row.append(info, actions);
  return row;
};

/**
 * Renders the add project form
 * @param {() => void} onUpdate - callback when project is created
 */
const renderAddProjectForm = (onUpdate) => {
  const form = document.createElement("div");
  form.className = "wm-npub-project-add-form";

  const pathField = document.createElement("div");
  pathField.className = "wm-npub-project-add-field";

  const pathLabel = document.createElement("label");
  pathLabel.textContent = "Directory";
  pathLabel.className = "wm-npub-project-add-label";

  const pathInput = document.createElement("input");
  pathInput.type = "text";
  pathInput.className = "wm-npub-project-add-input";
  pathInput.placeholder = "~/code/my-project";

  pathField.append(pathLabel, pathInput);

  const nameField = document.createElement("div");
  nameField.className = "wm-npub-project-add-field";

  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Name (optional)";
  nameLabel.className = "wm-npub-project-add-label";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "wm-npub-project-add-input";
  nameInput.placeholder = "My Project";

  nameField.append(nameLabel, nameInput);

  const errorMsg = document.createElement("p");
  errorMsg.className = "wm-npub-project-add-error";
  errorMsg.style.display = "none";

  const actions = document.createElement("div");
  actions.className = "wm-npub-project-add-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "wm-button small secondary";
  cancelBtn.textContent = "Cancel";

  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "wm-button small primary";
  submitBtn.textContent = "Add Project";

  actions.append(cancelBtn, submitBtn);
  form.append(pathField, nameField, errorMsg, actions);

  const hideForm = () => {
    form.remove();
  };

  cancelBtn.addEventListener("click", hideForm);

  submitBtn.addEventListener("click", async () => {
    const directoryPath = pathInput.value.trim();
    if (!directoryPath) {
      errorMsg.textContent = "Directory path is required";
      errorMsg.style.display = "block";
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Adding...";
    errorMsg.style.display = "none";

    const result = await createProject(directoryPath, nameInput.value);
    if (result.success) {
      hideForm();
      onUpdate();
    } else {
      errorMsg.textContent = result.error || "Failed to add project";
      errorMsg.style.display = "block";
      submitBtn.disabled = false;
      submitBtn.textContent = "Add Project";
    }
  });

  pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      submitBtn.click();
    } else if (e.key === "Escape") {
      hideForm();
    }
  });

  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      submitBtn.click();
    } else if (e.key === "Escape") {
      hideForm();
    }
  });

  return form;
};

/**
 * Renders the npub projects panel for settings
 * @param {() => void} onUpdate - callback when any project is updated
 */
const renderNpubProjectsPanel = (onUpdate) => {
  const card = document.createElement("section");
  card.className = "wm-card wm-npub-projects-card";

  const header = document.createElement("div");
  header.className = "wm-npub-projects-header";

  const heading = document.createElement("h2");
  heading.textContent = "My Projects";

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "wm-button small secondary";
  addBtn.textContent = "Add Project";

  header.append(heading, addBtn);

  const description = document.createElement("p");
  description.textContent = "Directories you've worked in are automatically tracked. You can also add projects manually.";

  card.append(header, description);

  // Container for the add form (inserted dynamically)
  const formContainer = document.createElement("div");
  formContainer.className = "wm-npub-project-form-container";
  card.append(formContainer);

  addBtn.addEventListener("click", () => {
    // Remove existing form if any
    formContainer.innerHTML = "";
    const form = renderAddProjectForm(onUpdate);
    formContainer.append(form);
    form.querySelector("input")?.focus();
  });

  if (npubProjectsState.loading) {
    const loading = document.createElement("p");
    loading.className = "wm-npub-projects-loading";
    loading.textContent = "Loading projects...";
    card.append(loading);
    return card;
  }

  if (npubProjectsState.error) {
    const error = document.createElement("p");
    error.className = "wm-npub-projects-error";
    error.textContent = `Error: ${npubProjectsState.error}`;
    card.append(error);
    return card;
  }

  if (npubProjectsState.items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "wm-npub-projects-empty";
    empty.textContent = "No projects tracked yet. Add a project or start a session in any directory to begin tracking.";
    card.append(empty);
    return card;
  }

  const list = document.createElement("div");
  list.className = "wm-npub-projects-list";

  npubProjectsState.items.forEach((project) => {
    list.append(renderProjectRow(project, onUpdate));
  });

  card.append(list);
  return card;
};

export { npubProjectsState, fetchNpubProjects, renderNpubProjectsPanel };
