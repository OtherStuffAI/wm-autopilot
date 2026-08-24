function createCornerIcon(collapsed) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("wm-live-header-toggle__icon");

  const paths = collapsed
    ? [
        "M9 4v5H4",
        "M15 4v5h5",
        "M9 20v-5H4",
        "M15 20v-5h5",
      ]
    : [
        "M8 4H4v4",
        "M16 4h4v4",
        "M8 20H4v-4",
        "M16 20h4v-4",
      ];

  paths.forEach((d) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  });

  return svg;
}

export function createLiveHeaderFullscreenToggle({ collapsed, onToggle }) {
  const button = document.createElement("button");
  const label = collapsed ? "Show header" : "Hide header";
  button.type = "button";
  button.className = "wm-live-header-toggle";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", collapsed ? "true" : "false");
  button.setAttribute("data-testid", "live-header-fullscreen-toggle");
  button.append(createCornerIcon(collapsed));
  button.addEventListener("click", () => {
    onToggle?.();
  });
  return button;
}
