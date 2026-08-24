/**
 * Workspace Tree Browser
 *
 * Displays a directory tree for discovering and importing apps.
 * Shows detected project types and allows one-click import.
 */

/**
 * Fetch the workspace directory tree from the API.
 * @param {number} [depth=4] - How deep to scan
 * @returns {Promise<{root: string, depth: number, nodes: TreeNode[]} | null>}
 */
async function fetchWorkspaceTree(depth = 4) {
  try {
    const response = await fetch(`/api/workspace/tree?depth=${encodeURIComponent(String(depth))}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error ?? response.statusText ?? "Failed to fetch tree");
    }
    return response.json();
  } catch (error) {
    console.warn("[tree] Failed to fetch workspace tree:", error);
    return null;
  }
}

/**
 * Humanize a folder name for display.
 * @param {string} name - Folder name
 * @returns {string}
 */
function humanizeFolderName(name) {
  if (!name) return "";
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Get display label for app type.
 * @param {string} appType - App type identifier
 * @returns {string}
 */
function getAppTypeLabel(appType) {
  const labels = {
    pm2: "PM2",
    node: "Node.js",
    python: "Python",
    rust: "Rust",
    go: "Go",
    make: "Make",
    docker: "Docker",
  };
  return labels[appType] ?? appType ?? "";
}

/**
 * Get icon for app type.
 * @param {string} appType - App type identifier
 * @returns {string}
 */
function getAppTypeIcon(appType) {
  const icons = {
    pm2: "⚙️",
    node: "📦",
    python: "🐍",
    rust: "🦀",
    go: "🔷",
    make: "🔧",
    docker: "🐳",
  };
  return icons[appType] ?? "📁";
}

/**
 * Initialize the workspace tree component.
 * @param {Object} deps - Dependencies
 * @param {Object} deps.state - Global app state
 * @param {Function} deps.refreshApps - Function to refresh apps list
 * @param {Function} deps.showToast - Function to show toast notifications
 * @returns {Object} Tree component API
 */
export function initWorkspaceTree({ state, refreshApps, showToast }) {
  const COLLAPSED_STORAGE_KEY = "wingman:workspace-tree-collapsed";

  // Initialize tree state if not present
  if (!state.workspaceTree) {
    const storedCollapsed = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    // Default to collapsed if no preference stored
    const isCollapsed = storedCollapsed === null ? true : storedCollapsed === "true";
    state.workspaceTree = {
      nodes: [],
      root: "",
      expanded: new Set(),
      loading: false,
      error: null,
      initialized: false,
      collapsed: isCollapsed,
    };
  }

  /**
   * Load the workspace tree from API.
   */
  async function loadTree() {
    if (state.workspaceTree.loading) return;

    state.workspaceTree.loading = true;
    state.workspaceTree.error = null;

    try {
      const result = await fetchWorkspaceTree(4);
      if (result) {
        state.workspaceTree.nodes = result.nodes ?? [];
        state.workspaceTree.root = result.root ?? "";
        state.workspaceTree.initialized = true;
      } else {
        state.workspaceTree.error = "Failed to load workspace tree";
      }
    } catch (error) {
      state.workspaceTree.error = error instanceof Error ? error.message : "Failed to load tree";
    } finally {
      state.workspaceTree.loading = false;
    }
  }

  /**
   * Toggle expansion of a tree node.
   * @param {string} path - Path to toggle
   */
  function toggleExpand(path) {
    if (state.workspaceTree.expanded.has(path)) {
      state.workspaceTree.expanded.delete(path);
    } else {
      state.workspaceTree.expanded.add(path);
    }
  }

  /**
   * Import an app from the tree.
   * @param {string} path - Directory path
   * @param {string} appType - Detected app type
   * @param {string} name - Folder name
   */
  async function importApp(path, appType, name) {
    const label = humanizeFolderName(name);

    try {
      const response = await fetch("/api/apps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label,
          root: path,
          discoverScripts: true,
        }),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to import app";
        throw new Error(message);
      }

      // Refresh both the tree (to show registered state) and apps list
      await Promise.all([loadTree(), refreshApps({ skipRender: false })]);

      // Focus on the new app card
      if (payload && payload.app && payload.app.id) {
        const as = window.Alpine?.store("apps");
        if (as) as.pendingFocusId = payload.app.id;
      }

      if (showToast) {
        showToast(`Imported "${label}" successfully`, "success");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to import app";
      if (showToast) {
        showToast(message, "error");
      }
    }
  }

  /**
   * Render a single tree node.
   * @param {Object} node - Tree node
   * @param {number} depth - Current depth level
   * @returns {HTMLElement}
   */
  function renderNode(node, depth = 0) {
    const item = document.createElement("div");
    item.className = "wm-tree-node";
    item.dataset.depth = String(depth);
    if (node.isWorktree) {
      item.dataset.worktree = "true";
    }
    if (node.isRegistered) {
      item.dataset.registered = "true";
    }

    const row = document.createElement("div");
    row.className = "wm-tree-row";
    row.style.paddingLeft = `${depth * 1.25}rem`;

    // Expand/collapse toggle
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    const isExpanded = state.workspaceTree.expanded.has(node.path);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "wm-tree-toggle";
    toggle.setAttribute("aria-label", isExpanded ? "Collapse" : "Expand");

    if (hasChildren) {
      toggle.textContent = isExpanded ? "▼" : "▶";
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleExpand(node.path);
        // Re-render the tree
        const container = item.closest(".wm-tree-content");
        if (container) {
          renderTree(container.parentElement);
        }
      });
    } else {
      toggle.textContent = "·";
      toggle.disabled = true;
      toggle.style.opacity = "0.3";
    }

    row.append(toggle);

    // Icon based on app type or folder
    const icon = document.createElement("span");
    icon.className = "wm-tree-icon";
    icon.textContent = node.appType ? getAppTypeIcon(node.appType) : "📁";
    row.append(icon);

    // Folder name
    const label = document.createElement("span");
    label.className = "wm-tree-label";
    label.textContent = node.name;
    row.append(label);

    // App type badge
    if (node.appType && !node.isRegistered) {
      const badge = document.createElement("span");
      badge.className = "wm-tree-badge";
      badge.textContent = getAppTypeLabel(node.appType);
      row.append(badge);
    }

    // Import button or registered indicator
    if (node.appType) {
      if (node.isRegistered) {
        const registered = document.createElement("span");
        registered.className = "wm-tree-registered";
        registered.textContent = "Registered";
        row.append(registered);
      } else {
        const importBtn = document.createElement("button");
        importBtn.type = "button";
        importBtn.className = "wm-tree-import";
        importBtn.textContent = "Import";
        importBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          importBtn.disabled = true;
          importBtn.textContent = "Importing...";
          importApp(node.path, node.appType, node.name).finally(() => {
            if (importBtn.isConnected) {
              importBtn.disabled = false;
              importBtn.textContent = "Import";
            }
          });
        });
        row.append(importBtn);
      }
    }

    item.append(row);

    // Render children if expanded
    if (hasChildren && isExpanded) {
      const childContainer = document.createElement("div");
      childContainer.className = "wm-tree-children";
      for (const child of node.children) {
        childContainer.append(renderNode(child, depth + 1));
      }
      item.append(childContainer);
    }

    return item;
  }

  /**
   * Render the complete tree into a container.
   * @param {HTMLElement} container - Container element
   */
  function renderTree(container) {
    if (!container) return;

    // Clear existing content
    const existingContent = container.querySelector(".wm-tree-content");
    if (existingContent) {
      existingContent.remove();
    }

    const content = document.createElement("div");
    content.className = "wm-tree-content";

    if (state.workspaceTree.loading && !state.workspaceTree.initialized) {
      const loading = document.createElement("div");
      loading.className = "wm-tree-loading";
      loading.textContent = "Scanning workspace...";
      content.append(loading);
    } else if (state.workspaceTree.error) {
      const error = document.createElement("div");
      error.className = "wm-tree-error";
      error.textContent = state.workspaceTree.error;
      content.append(error);
    } else if (state.workspaceTree.nodes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "wm-tree-empty";
      empty.textContent = "No projects found in workspace.";
      content.append(empty);
    } else {
      for (const node of state.workspaceTree.nodes) {
        content.append(renderNode(node, 0));
      }
    }

    container.append(content);
  }

  /**
   * Toggle sidebar collapsed state.
   * @param {HTMLElement} sidebar - Sidebar element to update
   */
  function toggleCollapsed(sidebar) {
    state.workspaceTree.collapsed = !state.workspaceTree.collapsed;
    localStorage.setItem(COLLAPSED_STORAGE_KEY, String(state.workspaceTree.collapsed));
    if (sidebar) {
      sidebar.dataset.collapsed = String(state.workspaceTree.collapsed);
    }
  }

  /**
   * Create the tree sidebar component.
   * @returns {HTMLElement}
   */
  function createSidebar() {
    const sidebar = document.createElement("aside");
    sidebar.className = "wm-tree-sidebar";
    sidebar.dataset.collapsed = String(state.workspaceTree.collapsed);

    // Header
    const header = document.createElement("div");
    header.className = "wm-tree-header";

    // Collapse toggle button
    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "wm-tree-collapse";
    collapseBtn.setAttribute("aria-label", "Toggle sidebar");
    collapseBtn.textContent = state.workspaceTree.collapsed ? "▶" : "◀";
    collapseBtn.addEventListener("click", () => {
      toggleCollapsed(sidebar);
      collapseBtn.textContent = state.workspaceTree.collapsed ? "▶" : "◀";
    });
    header.append(collapseBtn);

    const title = document.createElement("h3");
    title.textContent = "Projects";
    header.append(title);

    const headerActions = document.createElement("div");
    headerActions.className = "wm-tree-header-actions";

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "wm-tree-refresh";
    refreshBtn.setAttribute("aria-label", "Refresh");
    refreshBtn.textContent = "↻";
    refreshBtn.addEventListener("click", () => {
      loadTree().then(() => renderTree(sidebar));
    });
    headerActions.append(refreshBtn);

    header.append(headerActions);
    sidebar.append(header);

    // Initial load if not already loaded
    if (!state.workspaceTree.initialized && !state.workspaceTree.loading) {
      loadTree().then(() => renderTree(sidebar));
    } else {
      renderTree(sidebar);
    }

    return sidebar;
  }

  return {
    loadTree,
    renderTree,
    createSidebar,
    toggleExpand,
    importApp,
  };
}
