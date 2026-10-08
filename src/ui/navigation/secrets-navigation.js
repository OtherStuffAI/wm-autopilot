const SECRETS_ROUTE = "/secrets";

export function createSecretsNavigation({
  state, openIdentityLoginDialog, closeMenu, closeIdentityLoginDialog,
  deactivateLiveSessionRefresh, setCurrentRoute, setLastLoggedSessionId, render,
}) {
  function navigateToSecrets({ skipMenuClose = false } = {}) {
    if (!state.identity.authenticated) {
      openIdentityLoginDialog();
      return;
    }
    if (!skipMenuClose) closeMenu();
    closeIdentityLoginDialog();
    deactivateLiveSessionRefresh();
    setCurrentRoute("secrets");
    setLastLoggedSessionId(null);
    if (window.location.pathname !== SECRETS_ROUTE) {
      window.history.pushState({ route: "secrets" }, "", SECRETS_ROUTE);
    }
    render();
  }

  return { navigateToSecrets };
}
