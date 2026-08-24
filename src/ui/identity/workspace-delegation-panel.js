import {
  WORKSPACE_DELEGATION_DURATION_OPTIONS,
  WORKSPACE_DELEGATION_SCOPE_OPTIONS,
} from "./workspace-delegations.js";

function createSelectOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function createScopeCheckbox(option) {
  const label = document.createElement("label");
  label.className = "wm-identity-delegations__scope-option";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = "scope";
  input.value = option.value;
  input.checked = Boolean(option.defaultChecked);
  input.dataset.role = "workspace-delegation-scope";
  input.setAttribute("aria-label", option.label);

  const text = document.createElement("span");
  text.textContent = option.label;

  label.append(input, text);
  return label;
}

function createTextarea(labelText, role, placeholder) {
  const group = document.createElement("div");
  group.className = "wm-form-group";

  const label = document.createElement("label");
  label.textContent = labelText;

  const textarea = document.createElement("textarea");
  textarea.className = "wm-input";
  textarea.rows = 3;
  textarea.placeholder = placeholder;
  textarea.dataset.role = role;
  textarea.setAttribute("aria-label", labelText);

  group.append(label, textarea);
  return group;
}

export function renderWorkspaceDelegationPanel() {
  const section = document.createElement("section");
  section.className = "wm-identity-delegations";
  section.dataset.role = "workspace-delegations-section";
  section.dataset.testid = "workspace-delegations-panel";
  section.hidden = true;

  const heading = document.createElement("h3");
  heading.textContent = "Workspace Delegations";

  const description = document.createElement("p");
  description.className = "wm-identity-panel-description";
  description.textContent =
    "Grant your bot or another npub explicit access to your sessions, files, and apps. This is separate from delegate registry publishing.";

  const helper = document.createElement("p");
  helper.className = "wm-identity-helper";
  helper.dataset.role = "workspace-delegation-bot-hint";
  helper.textContent = "Tip: use your bot npub for first-party agent testing.";

  const form = document.createElement("form");
  form.className = "wm-identity-delegations__form";
  form.dataset.form = "workspace-delegation";
  form.dataset.testid = "workspace-delegation-form";

  const delegateGroup = document.createElement("div");
  delegateGroup.className = "wm-form-group";
  const delegateLabel = document.createElement("label");
  delegateLabel.textContent = "Delegate npub";
  const delegateRow = document.createElement("div");
  delegateRow.className = "wm-identity-delegations__delegate-row";
  const delegateInput = document.createElement("input");
  delegateInput.type = "text";
  delegateInput.className = "wm-input";
  delegateInput.placeholder = "npub1...";
  delegateInput.dataset.role = "workspace-delegation-delegate";
  delegateInput.dataset.testid = "workspace-delegation-delegate";
  delegateInput.setAttribute("aria-label", "Delegate npub");
  delegateInput.spellcheck = false;
  delegateInput.autocapitalize = "off";
  const useBotButton = document.createElement("button");
  useBotButton.type = "button";
  useBotButton.className = "wm-button secondary";
  useBotButton.dataset.action = "workspace-delegation-use-bot";
  useBotButton.textContent = "Use my bot";
  useBotButton.setAttribute("aria-label", "Use my bot npub");
  delegateRow.append(delegateInput, useBotButton);
  delegateGroup.append(delegateLabel, delegateRow);

  const scopeGroup = document.createElement("fieldset");
  scopeGroup.className = "wm-identity-delegations__scopes";
  scopeGroup.dataset.role = "workspace-delegation-scope-group";
  const scopeLegend = document.createElement("legend");
  scopeLegend.textContent = "Scopes";
  scopeGroup.append(scopeLegend);

  const scopeGrid = document.createElement("div");
  scopeGrid.className = "wm-identity-delegations__scope-grid";
  WORKSPACE_DELEGATION_SCOPE_OPTIONS.forEach((option) => {
    scopeGrid.append(createScopeCheckbox(option));
  });
  scopeGroup.append(scopeGrid);

  const settingsGrid = document.createElement("div");
  settingsGrid.className = "wm-identity-delegations__grid";

  const durationGroup = document.createElement("div");
  durationGroup.className = "wm-form-group";
  const durationLabel = document.createElement("label");
  durationLabel.textContent = "Duration";
  const durationSelect = document.createElement("select");
  durationSelect.className = "wm-input";
  durationSelect.dataset.role = "workspace-delegation-duration";
  durationSelect.setAttribute("aria-label", "Delegation duration");
  WORKSPACE_DELEGATION_DURATION_OPTIONS.forEach((option) => {
    durationSelect.append(createSelectOption(option.value, option.label));
  });
  durationGroup.append(durationLabel, durationSelect);

  const billingGroup = document.createElement("div");
  billingGroup.className = "wm-form-group";
  const billingLabel = document.createElement("label");
  billingLabel.textContent = "Billing";
  const billingSelect = document.createElement("select");
  billingSelect.className = "wm-input";
  billingSelect.dataset.role = "workspace-delegation-billing";
  billingSelect.setAttribute("aria-label", "Delegation billing mode");
  billingSelect.append(
    createSelectOption("delegate", "Delegate pays"),
    createSelectOption("owner", "Owner pays"),
    createSelectOption("shared", "Shared"),
  );
  billingGroup.append(billingLabel, billingSelect);

  const spendGroup = document.createElement("div");
  spendGroup.className = "wm-form-group";
  const spendLabel = document.createElement("label");
  spendLabel.textContent = "Spend limit (sats)";
  const spendInput = document.createElement("input");
  spendInput.type = "number";
  spendInput.min = "0";
  spendInput.step = "1";
  spendInput.className = "wm-input";
  spendInput.placeholder = "Optional";
  spendInput.dataset.role = "workspace-delegation-spend-limit";
  spendInput.setAttribute("aria-label", "Delegation spend limit");
  spendGroup.append(spendLabel, spendInput);

  settingsGrid.append(durationGroup, billingGroup, spendGroup);

  const filters = document.createElement("details");
  filters.className = "wm-identity-delegations__filters";
  const filtersSummary = document.createElement("summary");
  filtersSummary.textContent = "Resource filters";
  filters.append(filtersSummary);

  const filtersBody = document.createElement("div");
  filtersBody.className = "wm-identity-delegations__grid";
  filtersBody.append(
    createTextarea("Path prefixes", "workspace-delegation-path-prefixes", "/srv/projects\n/srv/shared"),
    createTextarea("App ids", "workspace-delegation-app-ids", "wingman-core\nmy-app"),
    createTextarea("App roots", "workspace-delegation-app-roots", "/srv/apps"),
    createTextarea("Project roots", "workspace-delegation-project-roots", "/srv/projects"),
    createTextarea("Trigger ids", "workspace-delegation-trigger-ids", "trigger-id"),
    createTextarea("WApp ids", "workspace-delegation-wapp-ids", "wapp-installation-id"),
    createTextarea("Workspace ids", "workspace-delegation-workspace-ids", "workspace-id"),
    createTextarea("Scope ids", "workspace-delegation-scope-ids", "scope-id"),
  );
  filters.append(filtersBody);

  const actions = document.createElement("div");
  actions.className = "wm-identity-button-row";
  const createButton = document.createElement("button");
  createButton.type = "submit";
  createButton.className = "wm-button";
  createButton.dataset.action = "workspace-delegation-create";
  createButton.dataset.testid = "workspace-delegation-create";
  createButton.textContent = "Create delegation";
  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "wm-button secondary";
  refreshButton.dataset.action = "workspace-delegation-refresh";
  refreshButton.textContent = "Refresh";
  actions.append(createButton, refreshButton);

  const feedback = document.createElement("p");
  feedback.className = "wm-identity-status-line";
  feedback.dataset.role = "workspace-delegation-feedback";
  feedback.setAttribute("aria-live", "polite");
  feedback.hidden = true;

  form.append(delegateGroup, scopeGroup, settingsGrid, filters, actions, feedback);

  const listHeading = document.createElement("h4");
  listHeading.textContent = "Current delegations";

  const list = document.createElement("div");
  list.className = "wm-identity-delegations__list";
  list.dataset.role = "workspace-delegations-list";
  list.dataset.testid = "workspace-delegations-list";

  section.append(heading, description, helper, form, listHeading, list);
  return section;
}
