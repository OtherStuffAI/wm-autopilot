import { createTodoState } from "./state.js";
import { createTodoView } from "./view.js";

function createTodoFeature({ onRenderRequested, getApps, getProjects, onUnauthorized }) {
  function requestRender() {
    if (typeof onRenderRequested === "function") {
      onRenderRequested();
    }
  }

  const stateApi = createTodoState({
    onStateChange: requestRender,
    getApps,
    getProjects,
    onUnauthorized,
  });

  const actions = {
    setComposerValue: stateApi.setComposerValue,
    setComposerCategory: stateApi.setComposerCategory,
    setComposerParentId: stateApi.setComposerParentId,
    createTodoFromComposer: stateApi.createTodoFromComposer,
    toggleStar: stateApi.toggleStar,
    deleteTodo: stateApi.deleteTodo,
    openTodo: stateApi.openTodo,
    closeTodo: stateApi.closeTodo,
    getDraft: stateApi.getDraft,
    updateDraft: stateApi.updateDraft,
    resetDraft: stateApi.resetDraft,
    saveDraft: stateApi.saveDraft,
    getAppLabel: stateApi.getAppLabel,
    getAppOptions: stateApi.getAppOptions,
    getProjectLabel: stateApi.getProjectLabel,
    getProjectOptions: stateApi.getProjectOptions,
    consumeComposerFocus: stateApi.consumeComposerFocus,
    getHighlightedTodos: stateApi.getHighlightedTodos,
  };

  const view = createTodoView({
    state: stateApi.state,
    actions,
  });

  return {
    state: stateApi.state,
    ensureLoaded: stateApi.ensureLoaded,
    refresh: stateApi.refresh,
    renderPage: view.renderPage,
    renderHomeCard: view.renderHomeCard,
    getHighlightedTodos: stateApi.getHighlightedTodos,
    reset: stateApi.reset,
  };
}

export { createTodoFeature };
