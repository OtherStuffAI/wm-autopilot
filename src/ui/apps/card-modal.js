export function showAppCardModal({
  app,
  renderAppCard,
}) {
  const existing = document.getElementById("app-card-modal");
  if (typeof HTMLDialogElement === "function" && existing instanceof HTMLDialogElement && existing.open) {
    existing.close();
    existing.remove();
  } else {
    existing?.remove();
  }

  const dialog = document.createElement("dialog");
  dialog.id = "app-card-modal";
  dialog.className = "wm-app-card-modal";
  dialog.dataset.testid = "app-card-modal";

  const shell = document.createElement("div");
  shell.className = "wm-app-card-modal__shell";

  const header = document.createElement("header");
  header.className = "wm-app-card-modal__header";
  const title = document.createElement("h2");
  title.textContent = app?.label ?? app?.id ?? "App details";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "wm-button secondary wm-button--small";
  closeButton.textContent = "Close";
  closeButton.setAttribute("aria-label", "Close app details");
  closeButton.dataset.testid = "app-card-modal-close";
  closeButton.addEventListener("click", () => dialog.close());
  header.append(title, closeButton);

  const body = document.createElement("div");
  body.className = "wm-app-card-modal__body";
  const card = renderAppCard(app);
  card.classList.add("wm-app-card--modal");
  body.append(card);

  shell.append(header, body);
  dialog.append(shell);

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });
  dialog.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest("[data-app-card-opens-dialog], .wm-app-links a")) return;
    if (dialog.open) {
      dialog.close();
    }
  }, { capture: true });
  dialog.addEventListener("close", () => {
    dialog.remove();
  });

  document.body.append(dialog);
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else if (typeof dialog.show === "function") {
    dialog.show();
  } else {
    dialog.setAttribute("open", "open");
  }
}
