import { createProjectState } from "./state.js";
import { createProjectView } from "./view.js";

function createProjectFeature({
  onRenderRequested,
  onCreateRequested,
  onProjectAppRequested,
  resolveApp,
  openAppDetails,
  triggerAppAction,
  isActionDisabled,
}) {
  const requestRender = () => {
    if (typeof onRenderRequested === "function") {
      onRenderRequested();
    }
  };

  const stateApi = createProjectState({
    onStateChange: requestRender,
  });

  const actions = {
    refresh: stateApi.refresh,
    setCreateFormValue: stateApi.setCreateFormValue,
    submitCreateProject: stateApi.submitCreateProject,
    openCreateDialog: () => {
      if (typeof onCreateRequested === "function") {
        onCreateRequested();
      }
    },
    openAppCreator: (project) => {
      if (typeof onProjectAppRequested === "function" && project?.id) {
        onProjectAppRequested(project);
      }
    },
    resolveApp: (entry) => {
      if (typeof resolveApp === "function") {
        return resolveApp(entry);
      }
      return null;
    },
    openAppDetails: (app) => {
      if (typeof openAppDetails === "function" && app) {
        openAppDetails(app);
      }
    },
    triggerAppAction: (appId, action) => {
      if (typeof triggerAppAction === "function" && appId && action) {
        return triggerAppAction(appId, action);
      }
      return false;
    },
    isActionDisabled: (app, action) => {
      if (typeof isActionDisabled === "function" && app && action) {
        return isActionDisabled(app, action);
      }
      return false;
    },
  };

  const view = createProjectView({
    state: stateApi.state,
    actions,
  });

  return {
    state: stateApi.state,
    ensureLoaded: stateApi.ensureLoaded,
    refresh: stateApi.refresh,
    renderPage: view.renderPage,
    setCreateFormValue: stateApi.setCreateFormValue,
    submitCreateProject: stateApi.submitCreateProject,
  };
}

export { createProjectFeature };
