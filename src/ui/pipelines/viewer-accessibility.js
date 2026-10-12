// Focus the nonmodal detail region after explicit selection.
export function focusViewerDrawer(view) {
  view.$nextTick?.(() => (view.$root || view.$el).querySelector(".pipeline-viewer-inspector")?.focus());
}
