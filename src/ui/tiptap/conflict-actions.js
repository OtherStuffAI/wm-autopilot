export function renderTiptapConflictActions(container, { onReload, getDraftMarkdown, showToast } = {}) {
  const actions = document.createElement("div");
  actions.className = "wm-tiptap-conflict__actions";

  const reloadButton = document.createElement("button");
  reloadButton.type = "button";
  reloadButton.className = "wm-button secondary";
  reloadButton.textContent = "Reload";
  reloadButton.addEventListener("click", () => {
    void onReload?.();
  });

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "wm-button secondary";
  copyButton.textContent = "Copy draft";
  copyButton.addEventListener("click", async () => {
    await navigator.clipboard?.writeText(getDraftMarkdown?.() ?? "");
    showToast?.("Draft copied", { duration: 1600 });
  });

  actions.append(reloadButton, copyButton);
  container.append(actions);
}
