import {
  escapeAttribute,
  escapeHtml,
  renderEmptyState,
  statusLabel,
} from "./view-utils.js";

export function renderFunctionsWorkspace(state) {
  return `
    <section class="wm-pipeline-workspace wm-pipeline-functions-workspace" aria-labelledby="pipeline-functions-title">
      <div class="wm-pipeline-panel wm-pipeline-list-panel">
        <div class="wm-pipeline-panel-header">
          <div>
            <h2 id="pipeline-functions-title">Functions</h2>
            <p class="wm-muted">${state.functions.length} function${state.functions.length === 1 ? "" : "s"} registered</p>
          </div>
          <button type="button" data-action="open-function-creator" data-testid="pipeline-new-function-action">New Function</button>
        </div>
        ${renderFunctionRootPaths(state)}
        ${renderFunctionRegistry(state)}
      </div>
      <div class="wm-pipeline-panel wm-pipeline-detail-panel">
        ${state.functionCreatorOpen ? renderFunctionCreator(state) : renderFunctionDetail(state)}
      </div>
    </section>
  `;
}

function renderFunctionRootPaths(state) {
  const root = state.root ?? {};
  return `
    <div class="wm-pipeline-root-list">
      <div>
        <strong>Shared</strong>
        <code>${escapeHtml(root.sharedFunctions ?? "~/.wingmen/pipelines/shared/functions")}</code>
      </div>
      <div>
        <strong>User</strong>
        <code>${escapeHtml(root.userFunctions ?? "~/.wingmen/pipelines/users/<alias>/functions")}</code>
      </div>
    </div>
  `;
}

function renderFunctionCreator(state) {
  return `
    <article class="wm-pipeline-creator" data-testid="pipeline-function-creator">
      <header class="wm-pipeline-detail-header">
        <div>
          <h2>Create Function</h2>
          <p class="wm-muted">Generate a versioned TypeScript function in your user pipeline functions directory.</p>
        </div>
        <button type="button" data-action="close-function-creator">Close</button>
      </header>
      <label class="wm-pipeline-textarea-field">
        <span>Function prompt</span>
        <textarea data-action="function-prompt" rows="10" placeholder="Describe the object-in/object-out function this pipeline should be able to call.">${escapeHtml(state.functionPrompt)}</textarea>
      </label>
      <div class="wm-pipeline-definition-actions">
        <button type="button" data-action="start-function-wizard" ${state.functionBusy ? "disabled" : ""}>
          ${state.functionBusy ? "Starting..." : "Start Function Wizard"}
        </button>
      </div>
      ${state.functionResult ? renderFunctionWizardResult(state.functionResult) : ""}
    </article>
  `;
}

function renderFunctionWizardResult(result) {
  return `
    <div class="wm-pipeline-wizard-result" data-testid="pipeline-function-wizard-result">
      <p><strong>Session:</strong> <code>${escapeHtml(result.sessionId ?? "--")}</code></p>
      <p><strong>Target:</strong> <code>${escapeHtml(result.targetPath ?? "--")}</code></p>
      <p><strong>Functions directory:</strong> <code>${escapeHtml(result.functionsDirectory ?? "--")}</code></p>
    </div>
  `;
}

function renderFunctionRegistry(state) {
  const functions = getSortedFunctions(state.functions);
  if (!functions.length) {
    return renderEmptyState("No pipeline functions are registered.", "New Function", "open-function-creator");
  }
  return `
    <div class="wm-pipeline-function-list" data-testid="pipeline-function-registry">
      ${functions.map((entry) => renderFunctionRow(entry, state.selectedFunctionName === entry.name)).join("")}
    </div>
  `;
}

function renderFunctionRow(entry, selected) {
  return `
    <button type="button" class="wm-pipeline-function-row" data-action="open-function" data-name="${escapeAttribute(entry.name)}" data-status="${escapeAttribute(entry.status)}" aria-current="${selected}">
      <span>
        <strong>${escapeHtml(entry.name)}</strong>
        <small>${escapeHtml(renderFunctionMeta(entry))}</small>
        ${entry.description ? `<p>${escapeHtml(entry.description)}</p>` : ""}
        ${entry.path ? `<code>${escapeHtml(entry.path)}</code>` : ""}
        ${entry.error ? `<p class="wm-error">${escapeHtml(entry.error)}</p>` : ""}
      </span>
      <span class="wm-pipeline-status-chip" data-status="${escapeAttribute(entry.status)}">${escapeHtml(renderStatus(entry.status))}</span>
    </button>
  `;
}

function renderFunctionDetail(state) {
  if (state.selectedFunctionLoading) return renderEmptyState("Loading function source.", "Refresh", "refresh");
  const detail = state.selectedFunctionDetail;
  if (!detail) return renderEmptyState("Select a function to inspect its source code.", "New Function", "open-function-creator");
  const entry = detail.function ?? {};
  return `
    <article class="wm-pipeline-definition-detail wm-pipeline-function-detail" data-testid="pipeline-function-detail">
      <header class="wm-pipeline-detail-header">
        <div>
          <h2>${escapeHtml(entry.name ?? "Function")}</h2>
          ${entry.description ? `<p>${escapeHtml(entry.description)}</p>` : `<p class="wm-muted">No description.</p>`}
          <p><code>${escapeHtml(detail.sourcePath ?? entry.path ?? "--")}</code></p>
        </div>
        <span class="wm-pipeline-status-chip" data-status="${escapeAttribute(entry.status ?? "ok")}">${escapeHtml(renderStatus(entry.status ?? "ok"))}</span>
      </header>
      <dl class="wm-pipeline-facts">
        <div><dt>Scope</dt><dd>${escapeHtml(entry.scope ?? "--")}</dd></div>
        <div><dt>Version</dt><dd>${escapeHtml(entry.version ?? "--")}</dd></div>
        <div><dt>Language</dt><dd>${escapeHtml(detail.language ?? "--")}</dd></div>
        <div><dt>Hash</dt><dd>${escapeHtml(entry.hash ?? "--")}</dd></div>
      </dl>
      ${detail.code ? renderHighlightedCode(detail.code) : `<p class="wm-muted">No source code is available for this registry entry.</p>`}
    </article>
  `;
}

function renderHighlightedCode(code) {
  return `
    <pre class="wm-pipeline-code-view" data-language="typescript"><code>${highlightCode(code)}</code></pre>
  `;
}

function highlightCode(code) {
  const tokenPattern = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\b(?:async|await|break|case|catch|const|continue|default|else|export|for|from|function|if|import|in|interface|let|null|return|string|throw|try|type|undefined|unknown|while)\b|\b\d+(?:\.\d+)?\b)/g;
  let cursor = 0;
  let output = "";
  for (const match of code.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    output += escapeHtml(code.slice(cursor, index));
    output += `<span class="${escapeAttribute(codeTokenClass(token))}">${escapeHtml(token)}</span>`;
    cursor = index + token.length;
  }
  output += escapeHtml(code.slice(cursor));
  return output;
}

function codeTokenClass(token) {
  if (token.startsWith("//") || token.startsWith("/*")) return "wm-code-token-comment";
  if (token.startsWith("\"") || token.startsWith("'") || token.startsWith("`")) return "wm-code-token-string";
  if (/^\d/.test(token)) return "wm-code-token-number";
  return "wm-code-token-keyword";
}

function getSortedFunctions(functions) {
  const statusRank = { error: 0, shadowed: 1, ok: 2 };
  return [...functions].sort((a, b) => {
    const statusDelta = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
    if (statusDelta) return statusDelta;
    return String(a.name ?? "").localeCompare(String(b.name ?? ""));
  });
}

function renderFunctionMeta(entry) {
  const parts = [entry.scope];
  if (entry.ownerAlias) parts.push(entry.ownerAlias);
  if (entry.version !== null && entry.version !== undefined) parts.push(`v${entry.version}`);
  if (entry.hash) parts.push(entry.hash);
  return parts.filter(Boolean).join(" - ");
}

function renderStatus(status) {
  if (status === "ok") return "OK";
  if (status === "shadowed") return "Shadowed";
  return statusLabel(status);
}
