import Alpine from "/vendor/alpinejs/module.esm.js";
import { createNativeViewerView } from "./viewer-view.js";
import { viewerTemplate } from "./viewer-template.js";

let sequence = 0;
export function mountNativePipelineViewer(root, route) {
  if (!route.id || !["runs", "definitions"].includes(route.section))
    return () => {};
  if (!document.querySelector("link[data-native-pipeline-viewer]")) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/pipelines/viewer.css";
    link.dataset.nativePipelineViewer = "";
    document.head.append(link);
  }
  const name = `nativePipelineViewer${++sequence}`;
  Alpine.data(name, () => createNativeViewerView({ route }));
  const element = document.createElement("section");
  element.className = "pipeline-viewer";
  element.setAttribute("x-data", name);
  element.innerHTML = viewerTemplate;
  const detail = root.querySelector(
    ".wm-pipeline-run-detail, .wm-pipeline-definition-detail",
  );
  if (!detail) return () => {};
  detail.append(element);
  root.classList.add("wm-native-pipeline-shell");
  // The production shell owns Alpine.start(); this subtree is dynamically mounted.
  Alpine.initTree(element);
  const observer = new MutationObserver(() => {
    if (!element.isConnected) dispose();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("pagehide", dispose, { once: true });
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    window.removeEventListener("pagehide", dispose);
    Alpine.destroyTree(element);
    element.remove();
  }
  return dispose;
}
