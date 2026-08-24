let mermaidModulePromise = null;
let renderSequence = 0;

function resolveTheme() {
  return document.body?.dataset?.theme === "light" ? "default" : "dark";
}

async function loadMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("/vendor/mermaid/mermaid.esm.min.mjs").then((module) => {
      const mermaid = module.default ?? module;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: resolveTheme(),
      });
      return mermaid;
    });
  }
  return mermaidModulePromise;
}

function getDiagramSource(container) {
  return container.querySelector(".wm-mermaid__source")?.textContent?.trim() ?? "";
}

function showMermaidError(container, error) {
  container.dataset.state = "error";
  const message = document.createElement("div");
  message.className = "wm-mermaid__error";
  message.setAttribute("role", "status");
  message.textContent = error instanceof Error ? error.message : "Unable to render Mermaid diagram.";
  container.append(message);
}

export async function renderMermaidDiagrams(root = document) {
  const containers = Array.from(root.querySelectorAll?.(".wm-mermaid:not([data-rendered])") ?? []);
  if (containers.length === 0) return;

  let mermaid = null;
  try {
    mermaid = await loadMermaid();
  } catch (error) {
    for (const container of containers) {
      container.dataset.rendered = "true";
      showMermaidError(container, error);
    }
    return;
  }

  for (const container of containers) {
    const source = getDiagramSource(container);
    container.dataset.rendered = "true";
    if (!source) {
      showMermaidError(container, new Error("Mermaid diagram is empty."));
      continue;
    }

    try {
      const id = `wm-mermaid-${Date.now()}-${renderSequence++}`;
      const { svg } = await mermaid.render(id, source);
      container.innerHTML = svg;
      container.dataset.state = "rendered";
    } catch (error) {
      showMermaidError(container, error);
    }
  }
}
