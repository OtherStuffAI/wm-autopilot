const PROTECTED_ROUTES = new Set([
  "apps",
  "chat",
  "files",
  "live",
  "nightwatch",
  "pipelines",
  "projects",
  "scheduler",
  "terminal",
]);

export function isProtectedRoute(route) {
  return PROTECTED_ROUTES.has(route);
}

export function shouldHoldProtectedRoute(route, { authenticated, authResolved }) {
  return isProtectedRoute(route) && !authenticated && !authResolved;
}

export function resolveRouteForAuth(route, { authenticated, authResolved, fallbackRoute = "home" }) {
  if (isProtectedRoute(route) && !authenticated && authResolved) {
    return fallbackRoute;
  }
  return route;
}

export function applyAuthRouteRedirect({
  route,
  authenticated,
  authResolved,
  setCurrentRoute,
  fallbackRoute = "home",
  fallbackPath = "/home",
  replaceHistory = true,
}) {
  const nextRoute = resolveRouteForAuth(route, { authenticated, authResolved, fallbackRoute });
  if (nextRoute === route) {
    return route;
  }

  setCurrentRoute(nextRoute);
  if (typeof window !== "undefined" && window.location?.pathname !== fallbackPath) {
    const state = { route: nextRoute };
    if (replaceHistory) {
      window.history.replaceState(state, "", fallbackPath);
    } else {
      window.history.pushState(state, "", fallbackPath);
    }
  }
  return nextRoute;
}

export function renderAuthPendingView() {
  const wrapper = document.createElement("section");
  wrapper.className = "wm-auth-pending";
  wrapper.setAttribute("aria-live", "polite");
  wrapper.setAttribute("data-testid", "auth-pending-view");

  const message = document.createElement("p");
  message.textContent = "Checking session...";
  wrapper.append(message);

  return wrapper;
}
