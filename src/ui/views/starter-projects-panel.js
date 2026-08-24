import {
  fetchAdminStarterProjectsApi,
  createAdminStarterProjectApi,
  updateAdminStarterProjectApi,
  deleteAdminStarterProjectApi,
} from "../services/starter-projects.js";
import { openConfirmDialog } from "../common/dialog-prompts.js";

export function initStarterProjectsPanel({ state, getCurrentRoute, render, showToast }) {
  const panelState = {
    items: [],
    loaded: false,
    loading: false,
    saving: false,
    deletingId: null,
    error: null,
    form: {
      id: null,
      name: "",
      gitUrl: "",
      webApp: false,
      scriptAuto: false,
      setupCommand: "bun run setup",
      notes: "",
    },
  };

  function resetForm() {
    panelState.form = {
      id: null,
      name: "",
      gitUrl: "",
      webApp: false,
      scriptAuto: false,
      setupCommand: "bun run setup",
      notes: "",
    };
  }

  function applyFormFromItem(item) {
    panelState.form = {
      id: item?.id ?? null,
      name: item?.name ?? "",
      gitUrl: item?.gitUrl ?? "",
      webApp: Boolean(item?.webApp),
      scriptAuto: Boolean(item?.scriptAuto),
      setupCommand: item?.setupCommand ?? "bun run setup",
      notes: item?.notes ?? "",
    };
  }

  async function ensureStarterProjectsLoaded({ force = false } = {}) {
    if (panelState.loading) return;
    if (panelState.loaded && !force) return;
    panelState.loading = true;
    panelState.error = null;
    try {
      panelState.items = await fetchAdminStarterProjectsApi();
      panelState.loaded = true;
    } catch (error) {
      panelState.error = error instanceof Error ? error.message : "Failed to load starter projects";
    } finally {
      panelState.loading = false;
    }
  }

  function readFormPayload() {
    const name = panelState.form.name.trim();
    const gitUrl = panelState.form.gitUrl.trim();
    const setupCommand = panelState.form.setupCommand.trim();
    const notes = panelState.form.notes.trim();
    if (!name) {
      throw new Error("Starter name is required");
    }
    if (!gitUrl) {
      throw new Error("Starter Git URL is required");
    }
    return {
      name,
      gitUrl,
      webApp: Boolean(panelState.form.webApp),
      scriptAuto: Boolean(panelState.form.scriptAuto),
      setupCommand: setupCommand.length > 0 ? setupCommand : null,
      notes: notes.length > 0 ? notes : null,
    };
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (panelState.saving) return;
    panelState.saving = true;
    panelState.error = null;
    try {
      const payload = readFormPayload();
      if (panelState.form.id) {
        await updateAdminStarterProjectApi(panelState.form.id, payload);
        showToast("Starter project updated", { type: "success" });
      } else {
        await createAdminStarterProjectApi(payload);
        showToast("Starter project created", { type: "success" });
      }
      resetForm();
      await ensureStarterProjectsLoaded({ force: true });
      if (getCurrentRoute() === "settings") render();
    } catch (error) {
      panelState.error = error instanceof Error ? error.message : "Failed to save starter project";
      if (getCurrentRoute() === "settings") render();
    } finally {
      panelState.saving = false;
    }
  }

  async function handleDelete(id) {
    if (!id || panelState.deletingId) return;
    const confirmed = await openConfirmDialog({
      title: "Delete Starter Project",
      description: "Delete this starter project?",
      confirmLabel: "Delete",
      testId: "delete-starter-project-dialog",
    });
    if (!confirmed) return;
    panelState.deletingId = id;
    panelState.error = null;
    try {
      await deleteAdminStarterProjectApi(id);
      if (panelState.form.id === id) {
        resetForm();
      }
      await ensureStarterProjectsLoaded({ force: true });
      showToast("Starter project deleted", { type: "success" });
      if (getCurrentRoute() === "settings") render();
    } catch (error) {
      panelState.error = error instanceof Error ? error.message : "Failed to delete starter project";
      if (getCurrentRoute() === "settings") render();
    } finally {
      panelState.deletingId = null;
    }
  }

  function renderStarterProjectsPanel() {
    const section = document.createElement("section");
    section.className = "wm-card";

    const heading = document.createElement("h2");
    heading.textContent = "Starter Templates";
    const description = document.createElement("p");
    description.textContent = "Define template repositories users can generate into new GitHub-backed apps.";
    section.append(heading, description);

    if (panelState.loading && !panelState.loaded) {
      const loading = document.createElement("p");
      loading.className = "wm-settings__port-note";
      loading.textContent = "Loading starter projects...";
      section.append(loading);
      return section;
    }

    if (panelState.error) {
      const error = document.createElement("p");
      error.className = "wm-project-form__error";
      error.textContent = panelState.error;
      section.append(error);
    }

    const list = document.createElement("div");
    list.className = "wm-starter-projects-list";
    const items = Array.isArray(panelState.items) ? panelState.items : [];
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-settings__port-note";
      empty.textContent = "No starter templates configured.";
      list.append(empty);
    } else {
      items.forEach((item) => {
        const card = document.createElement("article");
        card.className = "wm-starter-project-card";

        const title = document.createElement("h3");
        title.textContent = item.name ?? item.id ?? "Starter Project";
        card.append(title);

        const url = document.createElement("p");
        url.className = "wm-starter-project-card__url";
        url.textContent = item.gitUrl ?? "";
        card.append(url);

        const meta = document.createElement("p");
        meta.className = "wm-starter-project-card__meta";
        meta.textContent = `Web App: ${item.webApp ? "Yes" : "No"} | Auto Setup: ${item.scriptAuto ? "Yes" : "No"}`;
        card.append(meta);

        if (typeof item.notes === "string" && item.notes.trim().length > 0) {
          const notes = document.createElement("p");
          notes.className = "wm-settings__port-note";
          notes.textContent = item.notes;
          card.append(notes);
        }

        const actions = document.createElement("div");
        actions.className = "wm-starter-project-card__actions";

        const editButton = document.createElement("button");
        editButton.type = "button";
        editButton.className = "wm-button secondary";
        editButton.textContent = "Edit";
        editButton.addEventListener("click", () => {
          applyFormFromItem(item);
          render();
        });

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "wm-button secondary";
        deleteButton.textContent = panelState.deletingId === item.id ? "Deleting..." : "Delete";
        deleteButton.disabled = panelState.deletingId === item.id;
        deleteButton.addEventListener("click", () => {
          void handleDelete(item.id);
        });

        actions.append(editButton, deleteButton);
        card.append(actions);
        list.append(card);
      });
    }

    section.append(list);

    const form = document.createElement("form");
    form.className = "wm-starter-project-form";

    const formTitle = document.createElement("h3");
    formTitle.textContent = panelState.form.id ? "Edit Starter" : "Add Starter";
    form.append(formTitle);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.required = true;
    nameInput.placeholder = "Starter name";
    nameInput.value = panelState.form.name;
    nameInput.addEventListener("input", (event) => {
      panelState.form.name = event.target.value;
    });

    const gitInput = document.createElement("input");
    gitInput.type = "url";
    gitInput.required = true;
    gitInput.placeholder = "https://github.com/org/repo.git";
    gitInput.value = panelState.form.gitUrl;
    gitInput.addEventListener("input", (event) => {
      panelState.form.gitUrl = event.target.value;
    });

    const setupInput = document.createElement("input");
    setupInput.type = "text";
    setupInput.placeholder = "bun run setup";
    setupInput.value = panelState.form.setupCommand;
    setupInput.addEventListener("input", (event) => {
      panelState.form.setupCommand = event.target.value;
    });

    const notesInput = document.createElement("textarea");
    notesInput.rows = 2;
    notesInput.placeholder = "Notes";
    notesInput.value = panelState.form.notes;
    notesInput.addEventListener("input", (event) => {
      panelState.form.notes = event.target.value;
    });

    const webAppLabel = document.createElement("label");
    webAppLabel.className = "wm-checkbox";
    const webAppCheckbox = document.createElement("input");
    webAppCheckbox.type = "checkbox";
    webAppCheckbox.checked = Boolean(panelState.form.webApp);
    webAppCheckbox.addEventListener("change", (event) => {
      panelState.form.webApp = Boolean(event.target.checked);
    });
    const webAppText = document.createElement("span");
    webAppText.textContent = "Web App";
    webAppLabel.append(webAppCheckbox, webAppText);

    const scriptAutoLabel = document.createElement("label");
    scriptAutoLabel.className = "wm-checkbox";
    const scriptAutoCheckbox = document.createElement("input");
    scriptAutoCheckbox.type = "checkbox";
    scriptAutoCheckbox.checked = Boolean(panelState.form.scriptAuto);
    scriptAutoCheckbox.addEventListener("change", (event) => {
      panelState.form.scriptAuto = Boolean(event.target.checked);
    });
    const scriptAutoText = document.createElement("span");
    scriptAutoText.textContent = "Run setup automatically";
    scriptAutoLabel.append(scriptAutoCheckbox, scriptAutoText);

    const actions = document.createElement("div");
    actions.className = "wm-starter-project-form__actions";
    const saveButton = document.createElement("button");
    saveButton.type = "submit";
    saveButton.className = "wm-button";
    saveButton.textContent = panelState.saving ? "Saving..." : panelState.form.id ? "Save Changes" : "Create Starter";
    saveButton.disabled = panelState.saving;

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "wm-button secondary";
    cancelButton.textContent = "Clear";
    cancelButton.disabled = panelState.saving;
    cancelButton.addEventListener("click", () => {
      resetForm();
      render();
    });

    actions.append(saveButton, cancelButton);

    form.append(
      createField("Name", nameInput),
      createField("Git URL", gitInput),
      createField("Setup Command", setupInput),
      createField("Notes", notesInput),
      webAppLabel,
      scriptAutoLabel,
      actions,
    );
    form.addEventListener("submit", (event) => {
      void handleSubmit(event);
    });
    section.append(form);

    return section;
  }

  function createField(labelText, input) {
    const wrapper = document.createElement("label");
    wrapper.className = "wm-starter-project-form__field";
    const text = document.createElement("span");
    text.textContent = labelText;
    wrapper.append(text, input);
    return wrapper;
  }

  return {
    ensureStarterProjectsLoaded,
    renderStarterProjectsPanel,
  };
}
