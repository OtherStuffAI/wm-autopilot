import { CATEGORY_LABELS, TODO_CATEGORY_OPTIONS, formatDisplayDate, getParentCandidates } from "./utils.js";
import { createTodoDetailView } from "./detail-view.js";

function createTodoView({ state, actions }) {
  function renderPage() {
    const container = document.createElement("div");
    container.className = "wm-todos-page";

    const title = document.createElement("h1");
    title.className = "wm-todos-title";
    title.textContent = "Todos";
    container.append(title);

    container.append(renderTable());

    return container;
  }

  function renderTable() {
    const wrapper = document.createElement("section");
    wrapper.className = "wm-card wm-todo-table";

    wrapper.append(renderComposerRow());

    if (state.error) {
      const error = document.createElement("div");
      error.className = "wm-alert wm-alert-error";
      error.textContent = state.error;
      wrapper.append(error);
    }

    const table = document.createElement("table");
    table.className = "wm-todo-grid";
    const header = document.createElement("thead");
    header.append(renderHeaderRow());
    table.append(header);

    const body = document.createElement("tbody");
    if (state.loading && !state.initialized) {
      body.append(renderStatusRow("Loading todos…"));
    } else if (!state.loading && state.items.length === 0) {
      body.append(renderStatusRow("No todos yet. Capture your first task above."));
    } else {
      state.items.forEach((todo) => {
        body.append(renderTodoRow(todo));
        if (state.expandedId === todo.id) {
          body.append(renderExpandedRow(todo));
        }
      });
    }
    table.append(body);

    const tableContainer = document.createElement("div");
    tableContainer.className = "wm-table-container";
    tableContainer.append(table);

    wrapper.append(tableContainer);

    return wrapper;
  }

  function renderComposerRow() {
    const composer = document.createElement("div");
    composer.className = state.composer.error ? "wm-todo-composer has-error" : "wm-todo-composer";

    const input = document.createElement("input");
    input.className = "wm-todo-composer__input";
    input.type = "text";
    input.placeholder = "Capture a new todo and press Enter";
    input.value = state.composer.value;
    input.disabled = state.composer.saving;
    input.addEventListener("input", (event) => {
      actions.setComposerValue(event.target.value);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        actions.createTodoFromComposer();
      }
    });

    const inputWrapper = document.createElement("div");
    inputWrapper.className = "wm-todo-composer__input-wrapper";
    inputWrapper.append(input);

    const controls = document.createElement("div");
    controls.className = "wm-todo-composer__meta";

    const parentSelect = document.createElement("select");
    parentSelect.className = "wm-todo-composer__select";

    const syncParentOptions = () => {
      parentSelect.innerHTML = "";
      const defaultOption = document.createElement("option");
      defaultOption.value = "";
      defaultOption.textContent = "No parent";
      parentSelect.append(defaultOption);
      const candidates = getParentCandidates(state.items, state.composer.category, null);
      candidates.forEach((candidate) => {
        const option = document.createElement("option");
        option.value = candidate.id;
        option.textContent = candidate.title;
        if (state.composer.parentId === candidate.id) {
          option.selected = true;
        }
        parentSelect.append(option);
      });
      const disabled = state.composer.category === "rock";
      parentSelect.disabled = disabled;
      if (disabled) {
        parentSelect.value = "";
      } else if (state.composer.parentId) {
        parentSelect.value = state.composer.parentId;
      }
    };

    const categorySelect = document.createElement("select");
    categorySelect.className = "wm-todo-composer__select";
    TODO_CATEGORY_OPTIONS.forEach((option) => {
      const entry = document.createElement("option");
      entry.value = option.value;
      entry.textContent = option.label;
      if (state.composer.category === option.value) {
        entry.selected = true;
      }
      categorySelect.append(entry);
    });

    categorySelect.addEventListener("change", (event) => {
      const value = event.target.value;
      actions.setComposerCategory(value);
      syncParentOptions();
    });

    parentSelect.addEventListener("change", (event) => {
      const value = event.target.value.trim();
      actions.setComposerParentId(value || null);
    });

    syncParentOptions();

    controls.append(categorySelect, parentSelect);

    const icon = document.createElement("span");
    icon.className = "wm-todo-composer__icon";
    icon.textContent = "+";

    composer.append(inputWrapper, controls, icon);

    if (typeof actions.consumeComposerFocus === "function" && actions.consumeComposerFocus()) {
      requestAnimationFrame(() => {
        input.focus();
      });
    }

    if (state.composer.error) {
      const message = document.createElement("p");
      message.className = "wm-todo-composer__error";
      message.textContent = state.composer.error;
      composer.append(message);
    }

    return composer;
  }

  function renderHeaderRow() {
    const headerRow = document.createElement("tr");
    headerRow.className = "wm-todo-header";

    const columns = [
      { label: "", className: "wm-todo-col-star" },
      { label: "Todo", className: "wm-todo-col-title" },
      { label: "Category", className: "wm-todo-col-category" },
      { label: "Parent", className: "wm-todo-col-parent" },
      { label: "Due", className: "wm-todo-col-due" },
      { label: "Project", className: "wm-todo-col-project" },
      { label: "App", className: "wm-todo-col-app" },
      { label: "Created", className: "wm-todo-col-created" },
    ];

    columns.forEach((column) => {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = column.label;
      if (column.className) {
        cell.className = column.className;
      }
      headerRow.append(cell);
    });

    return headerRow;
  }

  function renderStatusRow(message) {
    const row = document.createElement("tr");
    row.className = "wm-todo-row is-status";

    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.textContent = message;
    row.append(cell);

    return row;
  }

  function renderTodoRow(todo) {
    const isExpanded = state.expandedId === todo.id;
    const row = document.createElement("tr");
    row.className = isExpanded ? "wm-todo-row is-expanded" : "wm-todo-row";
    row.dataset.todoId = todo.id;

    row.addEventListener("click", (event) => {
      if (event.target.closest("button") || event.target.closest("a") || event.target.closest("select") || event.target.tagName === "INPUT") {
        return;
      }
      actions.openTodo(todo.id);
    });

    row.append(renderStarCell(todo));
    row.append(renderTitleCell(todo));
    row.append(renderCategoryCell(todo));
    row.append(renderParentCell(todo));
    row.append(renderDueCell(todo));
    row.append(renderProjectCell(todo));
    row.append(renderAppCell(todo));
    row.append(renderCreatedCell(todo));

    return row;
  }

  function renderStarCell(todo) {
    const cell = document.createElement("td");
    cell.className = "wm-todo-col-star";

    const button = document.createElement("button");
    button.type = "button";
    button.className = todo.starred ? "wm-todo-star is-active" : "wm-todo-star";
    button.setAttribute("aria-pressed", todo.starred ? "true" : "false");
    const starLabel = todo.starred ? "Unstar todo" : "Star todo";
    button.title = starLabel;
    button.setAttribute("aria-label", starLabel);
    button.textContent = todo.starred ? "★" : "☆";
    button.disabled = state.savingIds.has(todo.id);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      actions.toggleStar(todo);
    });

    cell.append(button);
    return cell;
  }

  function renderTitleCell(todo) {
    const cell = document.createElement("td");
    cell.className = "wm-todo-col-title";

    const title = document.createElement("span");
    title.className = "wm-todo-title";
    title.textContent = todo.title;
    cell.append(title);

    if (todo.description) {
      const description = document.createElement("span");
      description.className = "wm-todo-subtitle";
      description.textContent = todo.description;
      cell.append(description);
    }

    return cell;
  }

  function renderDueCell(todo) {
    const cell = document.createElement("td");
    cell.className = "wm-todo-col-due";
    cell.textContent = formatDisplayDate(todo.dueDate) || "—";
    return cell;
  }

  function renderAppCell(todo) {
    const cell = document.createElement("td");
    cell.className = "wm-todo-col-app";
    cell.textContent = actions.getAppLabel(todo.appId) ?? "—";
    return cell;
  }

  function renderProjectCell(todo) {
    const cell = document.createElement("td");
    cell.className = "wm-todo-col-project";
    cell.textContent = actions.getProjectLabel(todo.projectId) ?? "—";
    return cell;
  }

  function renderCategoryCell(todo) {
    const cell = document.createElement("td");
    cell.className = "wm-todo-col-category";
    const label = CATEGORY_LABELS.get(todo.category) ?? "Sand";
    cell.textContent = label;
    return cell;
  }

  function renderParentCell(todo) {
    const cell = document.createElement("td");
    cell.className = "wm-todo-col-parent";
    if (!todo.parentId) {
      cell.textContent = "—";
      return cell;
    }
    const parent = state.items.find((item) => item.id === todo.parentId);
    cell.textContent = parent?.title ?? "—";
    return cell;
  }

  function renderCreatedCell(todo) {
    const cell = document.createElement("td");
    cell.className = "wm-todo-col-created";
    const createdAt = todo.createdAt ?? todo.updatedAt ?? null;
    cell.textContent = formatDisplayDate(createdAt) || "—";
    return cell;
  }

  function renderExpandedRow(todo) {
    const row = document.createElement("tr");
    row.className = "wm-todo-row-details";

    const cell = document.createElement("td");
    cell.colSpan = 8;
    const draft = actions.getDraft(todo.id);
    const detail = createTodoDetailView({
      todo,
      draft,
      actions,
      state,
    });
    cell.append(detail);
    row.append(cell);
    return row;
  }

  function renderHomeCard() {
    if (state.loading && !state.initialized) {
      return null;
    }
    const highlighted = actions.getHighlightedTodos();
    if (highlighted.length === 0) {
      return null;
    }

    const card = document.createElement("section");
    card.className = "wm-card wm-home-todos";

    const header = document.createElement("div");
    header.className = "wm-home-section-header";
    const title = document.createElement("h2");
    title.textContent = "Priority Todos";
    const actionsContainer = document.createElement("div");
    actionsContainer.className = "wm-home-section-actions";
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "wm-button secondary";
    openButton.textContent = "Open Todos";
    openButton.addEventListener("click", () => {
      if (typeof window.navigateToTodos === "function") {
        window.navigateToTodos({ skipMenuClose: true });
      }
    });
    actionsContainer.append(openButton);
    header.append(title, actionsContainer);

    const list = document.createElement("ul");
    list.className = "wm-home-todo-list";
    highlighted.forEach((todo) => {
      const isExpanded = state.expandedId === todo.id;
      const item = document.createElement("li");
      item.className = isExpanded ? "wm-home-todo is-expanded" : "wm-home-todo";

      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "wm-home-todo__trigger";
      trigger.addEventListener("click", () => {
        if (state.expandedId === todo.id) {
          actions.closeTodo(todo.id);
        } else {
          actions.openTodo(todo.id);
        }
      });

      const marker = document.createElement("span");
      marker.className = todo.starred ? "wm-home-todo__star" : "wm-home-todo__priority";
      const categoryLabel = CATEGORY_LABELS.get(todo.category) ?? todo.category ?? "";
      marker.textContent = todo.starred ? "★" : categoryLabel.slice(0, 1).toUpperCase();

      const text = document.createElement("span");
      text.className = "wm-home-todo__title";
      text.textContent = todo.title;

      const due = document.createElement("span");
      due.className = "wm-home-todo__due";
      due.textContent = formatDisplayDate(todo.dueDate);

      trigger.append(marker, text);
      if (due.textContent) {
        trigger.append(due);
      }

      item.append(trigger);

      if (isExpanded) {
        const detailWrapper = document.createElement("div");
        detailWrapper.className = "wm-home-todo__detail";
        const detail = createTodoDetailView({
          todo,
          draft: actions.getDraft(todo.id),
          actions,
          state,
        });
        detailWrapper.append(detail);
        item.append(detailWrapper);
      }

      list.append(item);
    });

    card.append(header, list);
    return card;
  }

  return {
    renderPage,
    renderHomeCard,
  };
}

export { createTodoView };
