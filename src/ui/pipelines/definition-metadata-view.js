import { countSteps, escapeHtml } from "./view-utils.js";

// Keep review's first screen for the process; setup remains explicitly inspectable.
export function renderDefinitionMetadata(definition) {
  return `<details class="pipeline-definition-metadata" data-testid="pipeline-definition-metadata">
    <summary aria-label="Inspect pipeline definition metadata">Definition details</summary>
    ${definition.description ? `<p>${escapeHtml(definition.description)}</p>` : ""}
    ${definition.scope !== "user" ? `<p class="wm-muted">Shared definitions cannot be edited directly. Create a user-owned version before changing them.</p>` : ""}
    <dl class="wm-pipeline-facts">
      <div><dt>Identity</dt><dd><code>${escapeHtml(definition.id)}</code></dd></div>
      <div><dt>Version</dt><dd>${escapeHtml(definition.version ?? "--")}</dd></div>
      <div><dt>Default</dt><dd>${definition.default ? "Yes" : "No"}</dd></div>
      <div><dt>Tags</dt><dd>${escapeHtml((definition.tags ?? []).join(", ") || "--")}</dd></div>
      <div><dt>Steps</dt><dd>${countSteps(definition)}</dd></div>
      <div><dt>Scope</dt><dd>${escapeHtml(definition.scope)}</dd></div>
      <div><dt>Path</dt><dd><code>${escapeHtml(definition.path)}</code></dd></div>
    </dl>
    <details><summary aria-label="Inspect pipeline default input">Default input</summary><pre>${escapeHtml(JSON.stringify(definition.input ?? {}, null, 2))}</pre></details>
  </details>`;
}
