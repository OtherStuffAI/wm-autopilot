import { TODO_CATEGORY_OPTIONS, getParentCandidates, toDateInputValue } from "./utils.js";
import { openConfirmDialog } from "../common/dialog-prompts.js";

function buildTodoFocusKey(todoId, field) {
  return `todo:${todoId}:${field}`;
}

function setTodoFocusKey(element, todoId, field) {
  if (!element || !todoId || !field) {
    return;
  }
  if (element.dataset) {
    element.dataset.focusKey = buildTodoFocusKey(todoId, field);
  }
}

function createTodoDetailView({ todo, draft, actions, state }) {
  if (!todo) {
    throw new Error("createTodoDetailView requires a todo");
  }
  if (!draft) {
    return createPlaceholder();
  }

  const form = document.createElement("form");
  form.className = "wm-todo-detail-form";
  form.noValidate = true;

  const titleField = createField({
    label: "Title",
    input: () => {
      const input = document.createElement("input");
      input.type = "text";
      input.required = true;
      input.value = draft.values.title;
      setTodoFocusKey(input, todo.id, "title");
      input.addEventListener("input", (event) => {
        actions.updateDraft(todo.id, { title: event.target.value });
      });
      return input;
    },
  });

  const descriptionField = createField({
    label: "Description",
    input: () => {
      const textarea = document.createElement("textarea");
      textarea.rows = 3;
      textarea.value = draft.values.description;
      setTodoFocusKey(textarea, todo.id, "description");
      textarea.addEventListener("input", (event) => {
        actions.updateDraft(todo.id, { description: event.target.value });
      });
      return textarea;
    },
  });

  const dueField = createField({
    label: "Due date",
    input: () => {
      const input = document.createElement("input");
      input.type = "date";
      input.value = toDateInputValue(draft.values.dueDate) || "";
      setTodoFocusKey(input, todo.id, "dueDate");
      input.addEventListener("input", (event) => {
        actions.updateDraft(todo.id, { dueDate: event.target.value || null });
      });
      return input;
    },
  });

  const categoryField = createField({
    label: "Category",
    input: () => {
      const select = document.createElement("select");
      TODO_CATEGORY_OPTIONS.forEach((option) => {
        const entry = document.createElement("option");
        entry.value = option.value;
        entry.textContent = option.label;
        if (draft.values.category === option.value) {
          entry.selected = true;
        }
        select.append(entry);
      });
      setTodoFocusKey(select, todo.id, "category");
      select.addEventListener("change", (event) => {
        const nextCategory = event.target.value;
        const candidates = getParentCandidates(state.items, nextCategory, todo.id);
        const canKeepParent =
          nextCategory !== "rock" && candidates.some((candidate) => candidate.id === draft.values.parentId);
        actions.updateDraft(todo.id, {
          category: nextCategory,
          parentId: canKeepParent ? draft.values.parentId : null,
        });
      });
      return select;
    },
  });

  const parentField = createField({
    label: "Parent",
    input: () => {
      const select = document.createElement("select");
      const defaultOption = document.createElement("option");
      defaultOption.value = "";
      defaultOption.textContent = "None";
      select.append(defaultOption);
      const candidates = getParentCandidates(state.items, draft.values.category, todo.id);
      candidates.forEach((candidate) => {
        const option = document.createElement("option");
        option.value = candidate.id;
        option.textContent = candidate.title;
        if (draft.values.parentId === candidate.id) {
          option.selected = true;
        }
        select.append(option);
      });
      const disabled = draft.values.category === "rock";
      select.disabled = disabled;
      if (disabled) {
        select.value = "";
      }
      setTodoFocusKey(select, todo.id, "parentId");
      select.addEventListener("change", (event) => {
        const value = event.target.value.trim();
        actions.updateDraft(todo.id, { parentId: value || null });
      });
      return select;
    },
  });

  const appField = createField({
    label: "Associated app",
    input: () => {
      const select = document.createElement("select");
      const defaultOption = document.createElement("option");
      defaultOption.value = "";
      defaultOption.textContent = "None";
      select.append(defaultOption);

      const apps = actions.getAppOptions();
      apps.forEach((app) => {
        if (!app?.id) {
          return;
        }
        const option = document.createElement("option");
        option.value = app.id;
        option.textContent = app.label ?? app.id;
        if (draft.values.appId === app.id) {
          option.selected = true;
        }
        select.append(option);
      });

      setTodoFocusKey(select, todo.id, "appId");
      select.addEventListener("change", (event) => {
        actions.updateDraft(todo.id, { appId: event.target.value });
      });
      return select;
    },
  });

  const projectField = createField({
    label: "Associated project",
    input: () => {
      const select = document.createElement("select");
      const defaultOption = document.createElement("option");
      defaultOption.value = "";
      defaultOption.textContent = "None";
      select.append(defaultOption);

      if (typeof actions.getProjectOptions === "function") {
        const projects = actions.getProjectOptions();
        projects.forEach((project) => {
          if (!project?.id) {
            return;
          }
          const option = document.createElement("option");
          option.value = project.id;
          option.textContent = project.name ?? project.id;
          if (draft.values.projectId === project.id) {
            option.selected = true;
          }
          select.append(option);
        });
      }

      setTodoFocusKey(select, todo.id, "projectId");
      select.addEventListener("change", (event) => {
        actions.updateDraft(todo.id, { projectId: event.target.value });
      });
      return select;
    },
  });

  const starredField = createField({
    label: "Starred",
    input: () => {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = Boolean(draft.values.starred);
      setTodoFocusKey(checkbox, todo.id, "starred");
      checkbox.addEventListener("change", (event) => {
        actions.updateDraft(todo.id, { starred: event.target.checked });
      });
      return checkbox;
    },
  });

  const actionsBar = document.createElement("div");
  actionsBar.className = "wm-todo-detail-actions";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "wm-button secondary";
  closeButton.textContent = "Close";
  closeButton.hidden = draft.dirty;
  closeButton.addEventListener("click", (event) => {
    event.preventDefault();
    actions.closeTodo(todo.id);
  });

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "wm-button secondary";
  cancelButton.textContent = "Cancel";
  cancelButton.hidden = !draft.dirty;
  cancelButton.addEventListener("click", (event) => {
    event.preventDefault();
    actions.resetDraft(todo.id);
  });

  const saveButton = document.createElement("button");
  saveButton.type = "submit";
  saveButton.className = "wm-button";
  saveButton.textContent = draft.saving ? "Saving…" : "Save";
  saveButton.disabled = draft.saving;
  saveButton.hidden = !draft.dirty;

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "wm-button secondary danger";
  deleteButton.textContent = state.deletingIds.has(todo.id) ? "Deleting…" : "Delete";
  deleteButton.disabled = state.deletingIds.has(todo.id);
  deleteButton.addEventListener("click", async (event) => {
    event.preventDefault();
    const confirmed = await openConfirmDialog({
      title: "Delete Todo",
      description: "Delete this todo?",
      confirmLabel: "Delete",
      testId: "delete-todo-dialog",
    });
    if (confirmed) {
      actions.deleteTodo(todo.id);
    }
  });

  actionsBar.append(closeButton, cancelButton, saveButton, deleteButton);

  if (draft.error) {
    const error = document.createElement("p");
    error.className = "wm-todo-detail-error";
    error.textContent = draft.error;
    actionsBar.append(error);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    actions.saveDraft(todo.id);
  });

  form.append(
    titleField,
    descriptionField,
    dueField,
    categoryField,
    parentField,
    appField,
    projectField,
    starredField,
    actionsBar,
  );
  return form;
}

function createField({ label, input }) {
  const field = document.createElement("label");
  field.className = "wm-todo-detail-field";

  const caption = document.createElement("span");
  caption.className = "wm-todo-detail-label";
  caption.textContent = label;

  const control = document.createElement("div");
  control.className = "wm-todo-detail-control";
  control.append(input());

  field.append(caption, control);
  return field;
}

function createPlaceholder() {
  const placeholder = document.createElement("p");
  placeholder.className = "wm-home-todo__placeholder";
  placeholder.textContent = "Unable to load details for this todo.";
  return placeholder;
}

export { createTodoDetailView };
