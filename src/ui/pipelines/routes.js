const PIPELINES_BASE = "/pipelines";
const ROUTE_SECTIONS = new Set(["runs", "definitions", "functions"]);

export function parsePipelineRoute(pathname = window.location.pathname) {
  const parts = pathname.split("/").filter(Boolean);
  const rawSection = parts[1] ?? "runs";
  const section = ROUTE_SECTIONS.has(rawSection) ? rawSection : "runs";
  const id = parts[2] ? decodeURIComponent(parts[2]) : "";
  const canonical = parts[0] !== "pipelines" || !ROUTE_SECTIONS.has(rawSection)
    ? makePipelinePath(section, id)
    : "";
  return { section, id, canonical };
}

export function makePipelinePath(section, id = "") {
  const safeSection = ROUTE_SECTIONS.has(section) ? section : "runs";
  return `${PIPELINES_BASE}/${safeSection}${id ? `/${encodeURIComponent(id)}` : ""}`;
}

export function pushPipelinePath(path) {
  if (window.location.pathname === path) return;
  window.history.pushState({ route: "pipelines" }, "", path);
}

export function replacePipelinePath(path) {
  if (window.location.pathname === path) return;
  window.history.replaceState({ route: "pipelines" }, "", path);
}
