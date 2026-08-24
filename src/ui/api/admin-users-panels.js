/**
 * Admin user panel renderers — ports tool, user management,
 * selection controls, and filter.
 *
 * Depends on: state, admin API module functions, utility helpers (via DI).
 */

import { applyAvatarImage } from "../utils/avatar.js";

export function initAdminUsersPanels(deps) {
  const {
    state,
    getCurrentRoute,
    render,
    createCollapsibleCard,
    abbreviateNpub,
    normaliseNpubValue,
    matchesAdminUserFilter,
    // Admin API module functions
    ensureAdminPortsToolState,
    submitAdminPortsAssignment,
    ensureAdminSelectionState,
    getAdminUserKey,
    setAdminUserSelected,
    clearAdminSelection,
    fetchAdminUsers,
    toggleUserOnboarding,
    deleteAdminUser,
    deleteSelectedAdminUsers,
    updateAdminUserNickname,
    addAdminUser,
  } = deps;

  // ── Helpers ────────────────────────────────────────────────────

  const renderIfSettings = () => {
    if (getCurrentRoute() === "settings") {
      render();
    }
  };

  // ── Ports card ─────────────────────────────────────────────────

  function buildAdminPortsCard() {
    ensureAdminPortsToolState();
    const portsTool = state.adminUsers.portsTool;
    const { card, body } = createCollapsibleCard({
      title: "Assign Ports to Users",
      className: "wm-admin-users wm-admin-users--ports",
      collapsed: state.settingsPanels.adminPortsCollapsed,
      onToggle(collapsed) {
        state.settingsPanels.adminPortsCollapsed = collapsed;
      },
    });

    const portsLayout = document.createElement("div");
    portsLayout.className = "wm-admin-users__tool";

    const portsIntro = document.createElement("p");
    portsIntro.className = "wm-admin-users__tool-help";
    portsIntro.textContent = "Assign additional ports to a specific user by providing their npub and the number of ports to add.";
    portsLayout.append(portsIntro);

    const portsForm = document.createElement("form");
    portsForm.className = "wm-admin-users__tool-form";
    portsForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (portsTool.busy) return;
      void submitAdminPortsAssignment();
    });

    const npubField = document.createElement("label");
    npubField.className = "wm-admin-users__tool-field";
    const npubSpan = document.createElement("span");
    npubSpan.textContent = "User npub";
    const npubInput = document.createElement("input");
    npubInput.type = "text";
    npubInput.placeholder = "npub1\u2026";
    npubInput.value = typeof portsTool.npub === "string" ? portsTool.npub : "";
    npubInput.autocomplete = "off";
    npubInput.disabled = portsTool.busy;
    npubInput.addEventListener("input", (event) => {
      ensureAdminPortsToolState();
      portsTool.npub = event.target.value;
      portsTool.error = null;
      portsTool.success = null;
    });
    npubField.append(npubSpan, npubInput);

    const countField = document.createElement("label");
    countField.className = "wm-admin-users__tool-field";
    const countSpan = document.createElement("span");
    countSpan.textContent = "Number of ports";
    const countInput = document.createElement("input");
    countInput.type = "number";
    countInput.min = "1";
    countInput.max = "100";
    countInput.step = "1";
    countInput.placeholder = "e.g. 3";
    countInput.value = typeof portsTool.count === "string" || typeof portsTool.count === "number" ? portsTool.count : "3";
    countInput.disabled = portsTool.busy;
    countInput.addEventListener("input", (event) => {
      ensureAdminPortsToolState();
      portsTool.count = event.target.value;
      portsTool.error = null;
      portsTool.success = null;
    });
    countField.append(countSpan, countInput);

    const portsControls = document.createElement("div");
    portsControls.className = "wm-admin-users__tool-controls";
    const submitButton = document.createElement("button");
    submitButton.type = "submit";
    submitButton.className = "wm-button";
    submitButton.disabled = portsTool.busy;
    submitButton.textContent = portsTool.busy ? "Assigning\u2026" : "Assign Ports";
    portsControls.append(submitButton);

    if (portsTool.error || portsTool.success) {
      const statusMessage = document.createElement("p");
      statusMessage.className = "wm-admin-users__tool-status";
      if (portsTool.error) {
        statusMessage.dataset.state = "error";
        statusMessage.textContent = portsTool.error;
      } else if (portsTool.success) {
        statusMessage.dataset.state = "success";
        statusMessage.textContent = portsTool.success;
      }
      portsControls.append(statusMessage);
    }

    portsForm.append(npubField, countField, portsControls);
    portsLayout.append(portsForm);
    body.append(portsLayout);
    return card;
  }

  // ── User management card ───────────────────────────────────────

  function buildAdminUserManagementCard() {
    const { card, body } = createCollapsibleCard({
      title: "User Management",
      className: "wm-admin-users wm-admin-users--listing",
      collapsed: state.settingsPanels.adminUsersCollapsed,
      onToggle(collapsed) {
        state.settingsPanels.adminUsersCollapsed = collapsed;
      },
    });

    const controls = document.createElement("div");
    controls.className = "wm-admin-users__controls";
    controls.append(buildAdminAddUserForm());
    controls.append(buildAdminUsersFilter());
    body.append(controls);

    if (state.adminUsers.loading && !state.adminUsers.initialized) {
      const loading = document.createElement("p");
      loading.className = "wm-admin-users__empty";
      loading.textContent = "Loading users\u2026";
      body.append(loading);
      return card;
    }

    if (state.adminUsers.error) {
      const errorBox = document.createElement("div");
      errorBox.className = "wm-admin-users__error";

      const message = document.createElement("p");
      message.textContent = state.adminUsers.error;

      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "wm-button secondary";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => {
        void fetchAdminUsers();
      });

      errorBox.append(message, retry);
      body.append(errorBox);
      return card;
    }

    const users = Array.isArray(state.adminUsers.items) ? state.adminUsers.items : [];
    if (users.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-admin-users__empty";
      empty.textContent = "No registered users yet.";
      body.append(empty);
      return card;
    }

    const filter = typeof state.adminUsers.filter === "string" ? state.adminUsers.filter.trim() : "";
    const filteredUsers = users.filter((user) => matchesAdminUserFilter(user, filter));

    if (filteredUsers.length === 0) {
      const emptyFiltered = document.createElement("p");
      emptyFiltered.className = "wm-admin-users__empty";
      emptyFiltered.textContent = filter.length > 0 ? "No users match your filter." : "No registered users yet.";
      body.append(emptyFiltered);
      return card;
    }

    const selectionControls = buildAdminUsersSelectionControls(filteredUsers);
    if (selectionControls) {
      body.append(selectionControls);
    }

    const list = document.createElement("div");
    list.className = "wm-admin-users__list";
    filteredUsers.forEach((user) => {
      const row = document.createElement("div");
      row.className = "wm-admin-users__item";
      const key = normaliseNpubValue(user.normalizedNpub ?? user.npub) ?? user.npub ?? "";
      const userPending = state.adminUsers.pending.has(key || user.normalizedNpub || user.npub);

      const selectionControl = document.createElement("label");
      selectionControl.className = "wm-admin-users__selection";
      const selectionCheckbox = document.createElement("input");
      selectionCheckbox.type = "checkbox";
      const isSelected = key ? ensureAdminSelectionState().has(key) : false;
      selectionCheckbox.checked = isSelected;
      selectionCheckbox.disabled =
        !key || userPending || state.adminUsers.loading || state.adminUsers.bulkDeleteBusy || !state.identity.isAdmin;
      selectionCheckbox.addEventListener("change", () => {
        if (!key) return;
        setAdminUserSelected(key, selectionCheckbox.checked);
        renderIfSettings();
      });
      selectionControl.append(selectionCheckbox);

      const avatar = document.createElement("div");
      avatar.className = "wm-admin-users__avatar";

      const details = document.createElement("div");
      details.className = "wm-admin-users__details";

      const nicknameValue =
        typeof user.nickname === "string" && user.nickname.trim().length > 0 ? user.nickname.trim() : null;
      const name = document.createElement("strong");
      const alias = typeof user.alias === "string" && user.alias.length > 0 ? user.alias : null;
      name.textContent = nicknameValue ?? alias ?? (user.npub ? abbreviateNpub(user.npub) : "Unknown user");

      const meta = document.createElement("span");
      meta.className = "wm-admin-users__meta";
      const safeAlias = alias ? `alias: ${alias}` : null;
      const safeNickname = nicknameValue ? `nickname: ${nicknameValue}` : null;
      const normalizedNpub = typeof user.normalizedNpub === "string" && user.normalizedNpub.length > 0 ? user.normalizedNpub : null;
      const safeNpub = normalizedNpub ?? user.npub ?? "";
      const metaParts = [];
      if (safeNickname) metaParts.push(safeNickname);
      if (safeAlias) metaParts.push(safeAlias);
      metaParts.push(`npub: ${safeNpub}`);
      meta.textContent = metaParts.join(" \u2022 ");

      const status = document.createElement("span");
      status.className = "wm-admin-users__status";
      status.textContent = user.approved || user.onboarded ? "Access: allowed" : "Access: blocked";

      const nicknameForm = document.createElement("form");
      nicknameForm.className = "wm-admin-users__nickname";
      nicknameForm.addEventListener("submit", (event) => {
        event.preventDefault();
        if (nicknameSave.disabled) return;
        state.adminUsers.nicknameDrafts.set(key, nicknameInput.value);
        void updateAdminUserNickname(user.npub, nicknameInput.value);
      });

      const nicknameField = document.createElement("label");
      nicknameField.className = "wm-admin-users__nickname-field";
      const nicknameLabel = document.createElement("span");
      nicknameLabel.textContent = "Admin nickname";
      const nicknameInput = document.createElement("input");
      nicknameInput.type = "text";
      nicknameInput.placeholder = "Add a short handle (only visible to admins)";
      const draftNickname =
        (state.adminUsers.nicknameDrafts instanceof Map && key ? state.adminUsers.nicknameDrafts.get(key) : undefined) ??
        (nicknameValue ?? "");
      nicknameInput.value = typeof draftNickname === "string" ? draftNickname : "";
      nicknameInput.autocomplete = "off";
      nicknameInput.disabled = userPending || state.adminUsers.loading;
      nicknameInput.addEventListener("input", (event) => {
        state.adminUsers.nicknameDrafts.set(key, event.target.value);
      });
      nicknameField.append(nicknameLabel, nicknameInput);

      const nicknameSave = document.createElement("button");
      nicknameSave.type = "submit";
      nicknameSave.className = "wm-button secondary";
      nicknameSave.textContent = userPending ? "Saving\u2026" : "Save";
      nicknameSave.disabled = userPending || state.adminUsers.loading;

      nicknameForm.append(nicknameField, nicknameSave);

      applyAvatarImage(avatar, user.pictureUrl, nicknameValue ?? alias ?? user.npub ?? "?");
      details.append(name, meta, status, nicknameForm);

      const actions = document.createElement("div");
      actions.className = "wm-admin-users__actions";

      const toggle = document.createElement("label");
      toggle.className = "wm-admin-users__toggle";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = Boolean(user.approved || user.onboarded);
      checkbox.disabled = userPending || state.adminUsers.loading;
      checkbox.addEventListener("change", () => {
        if (checkbox.disabled) return;
        toggleUserOnboarding(user.npub, checkbox.checked);
      });

      const label = document.createElement("span");
      label.textContent = "Allowed";

      toggle.append(checkbox, label);

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "wm-admin-users__delete-btn";
      deleteBtn.textContent = "Delete";
      deleteBtn.disabled = userPending || state.adminUsers.loading;
      deleteBtn.addEventListener("click", () => {
        if (deleteBtn.disabled) return;
        deleteAdminUser(user.npub, user.alias);
      });

      actions.append(toggle, deleteBtn);

      row.append(selectionControl, avatar, details, actions);
      list.append(row);
    });

    body.append(list);
    return card;
  }

  // ── Selection controls ─────────────────────────────────────────

  function buildAdminAddUserForm() {
    const form = document.createElement("form");
    form.className = "wm-admin-users__filter";
    form.dataset.testid = "admin-add-user-form";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (state.adminUsers.addBusy) return;
      void addAdminUser(state.adminUsers.addDraft);
    });

    const field = document.createElement("label");
    field.className = "wm-admin-users__filter-field";

    const label = document.createElement("span");
    label.textContent = "Add npub";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "npub1...";
    input.autocomplete = "off";
    input.value = typeof state.adminUsers.addDraft === "string" ? state.adminUsers.addDraft : "";
    input.disabled = Boolean(state.adminUsers.addBusy);
    input.addEventListener("input", (event) => {
      state.adminUsers.addDraft = event.target.value;
      state.adminUsers.addError = null;
    });
    field.append(label, input);

    const actions = document.createElement("div");
    actions.className = "wm-admin-users__filter-actions";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "wm-button";
    submit.disabled = Boolean(state.adminUsers.addBusy);
    submit.textContent = state.adminUsers.addBusy ? "Adding..." : "Add User";
    actions.append(submit);

    if (state.adminUsers.addError) {
      const error = document.createElement("p");
      error.className = "wm-admin-users__bulk-status";
      error.dataset.state = "error";
      error.textContent = state.adminUsers.addError;
      actions.append(error);
    }

    form.append(field, actions);
    return form;
  }

  function buildAdminUsersSelectionControls(filteredUsers) {
    if (!Array.isArray(filteredUsers) || filteredUsers.length === 0) {
      return null;
    }
    const selection = ensureAdminSelectionState();
    const selectedCount = selection.size;
    const container = document.createElement("div");
    container.className = "wm-admin-users__bulk-actions";

    const statusEl = document.createElement("span");
    statusEl.className = "wm-admin-users__bulk-status";
    statusEl.textContent =
      selectedCount === 0 ? "No users selected" : selectedCount === 1 ? "1 user selected" : `${selectedCount} users selected`;

    const visibleKeys = filteredUsers
      .map((user) => getAdminUserKey(user))
      .filter((key) => typeof key === "string" && key.length > 0);
    const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every((key) => selection.has(key));
    const disableSelectionControls = state.adminUsers.loading || state.adminUsers.bulkDeleteBusy;

    const selectVisible = document.createElement("button");
    selectVisible.type = "button";
    selectVisible.className = "wm-button secondary";
    selectVisible.textContent = allVisibleSelected ? "Clear visible" : "Select visible";
    selectVisible.disabled = disableSelectionControls || visibleKeys.length === 0;
    selectVisible.addEventListener("click", () => {
      if (selectVisible.disabled) return;
      visibleKeys.forEach((key) => {
        setAdminUserSelected(key, !allVisibleSelected);
      });
      renderIfSettings();
    });

    const clearAll = document.createElement("button");
    clearAll.type = "button";
    clearAll.className = "wm-link-button";
    clearAll.textContent = "Clear all";
    clearAll.disabled = disableSelectionControls || selectedCount === 0;
    clearAll.addEventListener("click", () => {
      if (clearAll.disabled) return;
      clearAdminSelection();
      renderIfSettings();
    });

    const deleteSelected = document.createElement("button");
    deleteSelected.type = "button";
    deleteSelected.className = "wm-button danger";
    deleteSelected.textContent = state.adminUsers.bulkDeleteBusy ? "Deleting\u2026" : "Delete selected";
    deleteSelected.disabled = disableSelectionControls || selectedCount === 0;
    deleteSelected.addEventListener("click", () => {
      if (deleteSelected.disabled) return;
      void deleteSelectedAdminUsers();
    });

    container.append(statusEl, selectVisible, clearAll, deleteSelected);
    return container;
  }

  // ── Filter ─────────────────────────────────────────────────────

  function buildAdminUsersFilter() {
    const filterForm = document.createElement("form");
    filterForm.className = "wm-admin-users__filter";
    filterForm.addEventListener("submit", (event) => {
      event.preventDefault();
      applyAdminUsersFilter();
    });

    const filterLabel = document.createElement("label");
    filterLabel.className = "wm-admin-users__filter-field";

    const labelText = document.createElement("span");
    labelText.textContent = "Filter";

    const filterInput = document.createElement("input");
    filterInput.type = "text";
    filterInput.placeholder = "nickname, alias or npub prefix";
    const currentDraft = typeof state.adminUsers.filterDraft === "string" ? state.adminUsers.filterDraft : state.adminUsers.filter;
    filterInput.value = typeof currentDraft === "string" ? currentDraft : "";
    filterInput.autocomplete = "off";
    filterInput.addEventListener("input", (event) => {
      state.adminUsers.filterDraft = event.target.value;
    });

    filterLabel.append(labelText, filterInput);

    const actions = document.createElement("div");
    actions.className = "wm-admin-users__filter-actions";

    const submitButton = document.createElement("button");
    submitButton.type = "submit";
    submitButton.className = "wm-button secondary";
    submitButton.textContent = "Filter";

    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.className = "wm-link-button";
    clearButton.textContent = "Clear";
    clearButton.addEventListener("click", () => {
      state.adminUsers.filterDraft = "";
      if (state.adminUsers.filter) {
        state.adminUsers.filter = "";
        renderIfSettings();
      } else {
        filterInput.value = "";
      }
    });

    actions.append(submitButton, clearButton);
    filterForm.append(filterLabel, actions);
    return filterForm;
  }

  function applyAdminUsersFilter() {
    const draft = typeof state.adminUsers.filterDraft === "string" ? state.adminUsers.filterDraft : "";
    const nextFilter = draft.trim();
    state.adminUsers.filterDraft = nextFilter;
    if (state.adminUsers.filter === nextFilter) {
      return;
    }
    state.adminUsers.filter = nextFilter;
    renderIfSettings();
  }

  // ── Public API ─────────────────────────────────────────────────

  return {
    renderAdminUsersPanel,
  };

  function renderAdminUsersPanel() {
    const container = document.createDocumentFragment();

    ensureAdminPortsToolState();
    const userManagementCard = buildAdminUserManagementCard();
    container.append(userManagementCard);

    const portsCard = buildAdminPortsCard();
    container.append(portsCard);

    return container;
  }
}
