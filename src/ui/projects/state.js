function createProjectState({ onStateChange }) {
  const state = {
    items: [],
    loading: false,
    error: null,
    initialized: false,
    createForm: {
      name: "",
      rootPath: "",
      submitting: false,
      error: null,
    },
  };

  const notify = () => {
    if (typeof onStateChange === "function") {
      onStateChange();
    }
  };

  const readError = async (response) => {
    const payload = await response.json().catch(() => ({}));
    const message = typeof payload?.error === "string" ? payload.error : response.statusText;
    return message || "Request failed";
  };

  const setProjects = (projects) => {
    state.items = Array.isArray(projects) ? projects : [];
    state.initialized = true;
  };

  const upsertProject = (project) => {
    if (!project || !project.id) {
      return;
    }
    const index = state.items.findIndex((item) => item.id === project.id);
    if (index === -1) {
      state.items = [project, ...state.items];
      return;
    }
    const next = state.items.slice();
    next[index] = project;
    state.items = next;
  };

  const fetchProjects = async () => {
    state.loading = true;
    state.error = null;
    notify();
    try {
      const response = await fetch("/api/projects", {
        headers: {
          "cache-control": "no-cache",
        },
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = await response.json().catch(() => ({}));
      setProjects(Array.isArray(payload?.projects) ? payload.projects : []);
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.loading = false;
      notify();
    }
  };

  const ensureLoaded = async () => {
    if (state.initialized || state.loading) {
      return;
    }
    await fetchProjects();
  };

  const refresh = async () => {
    await fetchProjects();
  };

  const setCreateFormValue = (field, value) => {
    if (!Object.prototype.hasOwnProperty.call(state.createForm, field)) {
      return;
    }
    state.createForm[field] = value;
    if (state.createForm.error) {
      state.createForm.error = null;
      notify();
    }
  };

  const submitCreateProject = async () => {
    if (state.createForm.submitting) {
      return false;
    }
    const name = state.createForm.name.trim();
    const rootPath = state.createForm.rootPath.trim();
    if (!name || !rootPath) {
      state.createForm.error = "Project name and folder are required";
      notify();
      return false;
    }
    state.createForm.submitting = true;
    state.createForm.error = null;
    notify();
    let success = false;
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name,
          rootPath,
        }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = await response.json().catch(() => ({}));
      if (payload?.project) {
        upsertProject(payload.project);
      } else {
        await fetchProjects();
      }
      state.createForm.name = "";
      state.createForm.rootPath = "";
      success = true;
    } catch (error) {
      state.createForm.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.createForm.submitting = false;
      notify();
    }
    return success && !state.createForm.error;
  };

  return {
    state,
    ensureLoaded,
    refresh,
    setCreateFormValue,
    submitCreateProject,
  };
}

export { createProjectState };
