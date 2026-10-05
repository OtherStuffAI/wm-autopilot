// Keep keyboard navigation in the pinned overlay until it is dismissed.
export function focusViewerDrawer(view) {
  view.$nextTick?.(() => (view.$root || view.$el).querySelector(".pipeline-viewer-inspector")?.focus());
}
export function trapViewerDrawer(event) {
  const drawer = event.currentTarget;
  const controls = [...drawer.querySelectorAll("button,input,a[href],select")]
    .filter((element) => !element.disabled && element.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  if (!first) { event.preventDefault(); return; }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === drawer)) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === drawer)) {
    event.preventDefault(); first.focus();
  }
}
