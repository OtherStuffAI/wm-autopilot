import { escapeAttribute, escapeHtml } from "./view-utils.js";

export function renderPipelineRunLink(id, label) {
  if (typeof id !== "string" || !id) return "";
  return `<button type="button" data-action="open-run" data-id="${escapeAttribute(id)}"
    aria-label="${escapeAttribute(label)} ${escapeAttribute(id)}" data-testid="pipeline-child-run-link">
    ${escapeHtml(label)} <code>${escapeHtml(id.slice(0, 8))}</code></button>`;
}

export function renderPipelineComposition(composition) {
  if (!composition) return "";
  const links = [renderPipelineRunLink(composition.parent?.parentRunId, "Open parent run"),
    ...(composition.children ?? []).map(child => renderPipelineRunLink(child.childRunId, "Open child run"))].filter(Boolean);
  const version = composition.definitionVersion ?? "Unversioned";
  return `<div aria-label="Pipeline composition" data-testid="pipeline-composition">
    <p>Definition version: ${escapeHtml(String(version))}${composition.definitionHash ? ` · SHA-256 <code>${escapeHtml(composition.definitionHash)}</code>` : ""}</p>
    ${links.join(" ")}</div>`;
}
