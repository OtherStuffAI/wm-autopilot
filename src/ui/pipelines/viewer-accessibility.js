// Wait for the nonmodal region's x-show transition before moving focus.
export function focusViewerDrawer(view) {
  const region = (view.$root || view.$el).querySelector(".pipeline-viewer-inspector");
  view.$nextTick?.(() => requestAnimationFrame(() => region?.focus({ preventScroll: true })));
}
