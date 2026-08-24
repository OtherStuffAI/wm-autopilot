import { bindPipelineValueInspector } from "./value-inspector.js";

export function bindPipelinesPageActions(root, page, actions) {
  bindRouteActions(root, page, actions);
  bindHeaderActions(root, page, actions);
  bindRunActions(root, page, actions);
  bindDefinitionActions(root, page, actions);
  bindWizardActions(root, page, actions);
  bindFunctionActions(root, page, actions);
  bindPipelineValueInspector(root);
}

function bindRouteActions(root, page, actions) {
  root.querySelectorAll('[data-action="navigate-pipeline"]').forEach((button) => {
    button.addEventListener("click", async () => {
      await actions.navigate(page, button.dataset.path ?? "");
    });
  });
}

function bindHeaderActions(root, page, actions) {
  root.querySelector('[data-action="refresh"]')?.addEventListener("click", async () => {
    await actions.refresh(page);
  });
  root.querySelectorAll('[data-action="open-launcher"]').forEach((button) => {
    button.addEventListener("click", async () => {
      await actions.openLauncher(page);
    });
  });
  root.querySelectorAll('[data-action="close-launcher"]').forEach((button) => {
    button.addEventListener("click", () => actions.closeLauncher(page));
  });
}

function bindRunActions(root, page, actions) {
  root.querySelector('[data-action="run-search"]')?.addEventListener("input", (event) => {
    actions.updateRunSearch(page, event.target?.value ?? "");
  });
  root.querySelector('[data-action="run-tag-filter"]')?.addEventListener("change", (event) => {
    actions.setRunTagFilter(page, event.target?.value ?? "");
  });
  root.querySelectorAll('[data-action="set-run-filter"]').forEach((button) => {
    button.addEventListener("click", () => actions.setRunFilter(page, button.dataset.filter ?? "all"));
  });
  root.querySelectorAll('[data-action="resume-run-from-failure"]').forEach((button) => {
    button.addEventListener("click", async () => {
      await actions.resumeRunFromFailure(page, button.dataset.id ?? "");
    });
  });
  root.querySelectorAll('[data-action="cancel-run"]').forEach((button) => {
    button.addEventListener("click", async () => {
      await actions.cancelRun(page, button.dataset.id ?? "");
    });
  });
  root.querySelectorAll('[data-action="open-run"]').forEach((button) => {
    button.addEventListener("click", async () => {
      await actions.openRun(page, button.dataset.id ?? "");
    });
  });
  root.querySelectorAll('[data-action="set-run-tab"]').forEach((button) => {
    button.addEventListener("click", async () => {
      await actions.setRunTab(page, button.dataset.tab ?? "overview");
    });
  });
  root.querySelectorAll('[data-action="select-step"]').forEach((button) => {
    button.addEventListener("click", async () => {
      await actions.selectStep(page, button.dataset.runId ?? "", button.dataset.stepId ?? "");
    });
  });
  root.querySelectorAll('[data-action="close-step-detail"]').forEach((button) => {
    button.addEventListener("click", () => actions.closeStepDetail(page));
  });
}

function bindDefinitionActions(root, page, actions) {
  root.querySelector('[data-action="definition-search"]')?.addEventListener("input", (event) => {
    actions.updateDefinitionSearch(page, event.target?.value ?? "");
  });
  root.querySelector('[data-action="definition-tag-filter"]')?.addEventListener("change", (event) => {
    actions.setDefinitionTagFilter(page, event.target?.value ?? "");
  });
  root.querySelectorAll('[data-action="set-definition-filter"]').forEach((button) => {
    button.addEventListener("click", () => actions.setDefinitionFilter(page, button.dataset.filter ?? "all"));
  });
  root.querySelectorAll('[data-action="open-definition"]').forEach((button) => {
    button.addEventListener("click", async () => {
      await actions.openDefinition(page, button.dataset.id ?? "");
    });
  });
  root.querySelector('[data-action="select-launcher-definition"]')?.addEventListener("change", (event) => {
    actions.selectLauncherDefinition(page, event.target?.value ?? "");
  });
  root.querySelector('[data-action="run-input"]')?.addEventListener("input", (event) => {
    actions.updateRunInput(event.target?.value ?? "");
  });
  root.querySelector('[data-action="open-launcher-for-definition"]')?.addEventListener("click", async (event) => {
    await actions.openLauncherForDefinition(page, event.currentTarget?.dataset?.id ?? "");
  });
}

function bindWizardActions(root, page, actions) {
  root.querySelectorAll('[data-action="open-creator"]').forEach((button) => {
    button.addEventListener("click", async () => {
      await actions.openCreator(page);
    });
  });
  root.querySelector('[data-action="close-creator"]')?.addEventListener("click", () => actions.closeCreator(page));
  root.querySelector('[data-action="wizard-prompt"]')?.addEventListener("input", (event) => {
    actions.updateWizardPrompt(event.target?.value ?? "");
  });
  root.querySelector('[data-action="start-wizard"]')?.addEventListener("click", async () => {
    await actions.startCreateWizard(page);
  });
  root.querySelector('[data-action="open-edit-wizard"]')?.addEventListener("click", (event) => {
    actions.openEditWizard(page, event.currentTarget?.dataset?.id ?? "");
  });
  root.querySelectorAll('[data-action="open-manual-edit"]').forEach((button) => {
    button.addEventListener("click", (event) => {
      actions.openManualEdit(page, event.currentTarget?.dataset?.id ?? "");
    });
  });
  root.querySelectorAll('[data-action="cancel-manual-edit"]').forEach((button) => {
    button.addEventListener("click", () => actions.cancelManualEdit(page));
  });
  root.querySelectorAll('[data-action="manual-edit-field"]').forEach((input) => {
    input.addEventListener("input", (event) => {
      actions.updateManualEditField(event.target?.dataset?.field ?? "", event.target?.value ?? "");
    });
  });
  root.querySelectorAll('[data-action="manual-edit-agent-prompt"]').forEach((input) => {
    input.addEventListener("input", (event) => {
      actions.updateManualAgentPrompt(event.target?.dataset?.stepIndex ?? "", event.target?.value ?? "");
    });
  });
  root.querySelector('[data-action="manual-edit-default"]')?.addEventListener("change", (event) => {
    actions.updateManualEditDefault(event.target?.checked === true);
  });
  root.querySelector('[data-action="save-manual-edit"]')?.addEventListener("click", async (event) => {
    await actions.saveManualEdit(page, event.currentTarget?.dataset?.id ?? "");
  });
  root.querySelector('[data-action="cancel-edit-wizard"]')?.addEventListener("click", () => actions.cancelEditWizard(page));
  root.querySelector('[data-action="edit-prompt"]')?.addEventListener("input", (event) => {
    actions.updateEditPrompt(event.target?.value ?? "");
  });
  root.querySelector('[data-action="start-edit-wizard"]')?.addEventListener("click", async (event) => {
    await actions.startEditWizard(page, event.currentTarget?.dataset?.id ?? "");
  });
  root.querySelector('[data-action="run-selected-definition"]')?.addEventListener("click", async () => {
    await actions.startSelectedRun(page);
  });
}

function bindFunctionActions(root, page, actions) {
  root.querySelectorAll('[data-action="open-function-creator"]').forEach((button) => {
    button.addEventListener("click", async () => {
      await actions.openFunctionCreator(page);
    });
  });
  root.querySelector('[data-action="close-function-creator"]')?.addEventListener("click", () => actions.closeFunctionCreator(page));
  root.querySelector('[data-action="function-prompt"]')?.addEventListener("input", (event) => {
    actions.updateFunctionPrompt(event.target?.value ?? "");
  });
  root.querySelector('[data-action="start-function-wizard"]')?.addEventListener("click", async () => {
    await actions.startFunctionWizard(page);
  });
  root.querySelectorAll('[data-action="open-function"]').forEach((button) => {
    button.addEventListener("click", async () => {
      await actions.openFunction(page, button.dataset.name ?? "");
    });
  });
}
