export function showDialogElement(dialog) {
  if (!dialog) {
    return false;
  }
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    return true;
  }
  if (typeof dialog.show === "function") {
    dialog.show();
    return true;
  }
  dialog.setAttribute("open", "open");
  return true;
}
