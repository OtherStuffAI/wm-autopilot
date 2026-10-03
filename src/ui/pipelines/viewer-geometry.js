import { renderPipelineConnections } from "./viewer-diagram.js";
import { wiringEndpoints } from "./viewer-projection.js";

// Reviewed measured port layout, including retained carried metadata lanes.
export function measureViewerConnections(view) {
  const canvas = view.$el?.querySelector(".pipeline-viewer-canvas");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect(),
    ports = [...canvas.querySelectorAll("[data-port-node]")];
  const find = (node, side, path) =>
    ports.find(
      (el) =>
        el.dataset.portNode === node &&
        el.dataset.portSide === side &&
        el.dataset.portPath === path,
    );
  view.diagramWidth = canvas.scrollWidth;
  view.diagramHeight = canvas.scrollHeight;
  const cardsBottom = Math.max(
    ...[...canvas.querySelectorAll(".pipeline-viewer-step")].map(
      (card) => card.getBoundingClientRect().bottom - rect.top,
    ),
    0,
  );
  view.edges = view.wires.flatMap((wire, wireIndex) =>
    wiringEndpoints(wire).flatMap((endpoint, portIndex) => {
      const index = wireIndex * 100 + portIndex;
      const source = find(wire.sourceStepKey, "outputs", endpoint.sourcePath),
        target = find(wire.targetStepKey, "inputs", endpoint.targetPath);
      if (!target || (!source && wire.sourceStepKey)) return [];
      const b = target.getBoundingClientRect(),
        a = source?.getBoundingClientRect() || {
          right: rect.left,
          top: b.top - 30,
          height: b.height,
        },
        mobile = globalThis.innerWidth <= 850;
      const x1 = a.right - rect.left,
        y1 = a.top + a.height / 2 - rect.top,
        x2 = mobile ? b.right - rect.left : b.left - rect.left,
        y2 = b.top + b.height / 2 - rect.top;
      const lane = mobile
        ? Math.max(x1, x2) + 16 + (index % 3) * 10
        : Math.max(x1 + 20, (x1 + x2) / 2);
      const bypassY = cardsBottom + 24 + (wireIndex % 4) * 18;
      const bypass = !mobile && wire.carriedForward;
      return [
        {
          wire,
          index,
          path: mobile
            ? `M ${x1} ${y1} H ${lane} V ${y2} H ${x2}`
            : bypass
              ? `M ${x1} ${y1} H ${x1 + 12} V ${bypassY} H ${x2 - 12} V ${y2} H ${x2}`
              : `M ${x1} ${y1} C ${lane} ${y1}, ${lane} ${y2}, ${x2} ${y2}`,
          labelX: mobile ? lane - 4 : (x1 + x2) / 2,
          labelY: mobile
            ? (y1 + y2) / 2
            : bypass
              ? bypassY - 8
              : Math.min(y1, y2) - 10,
          label:
            (source?.querySelector("span")?.textContent || wire.sourcePath) +
            (wire.carriedForward ? " ⇢ carried → " : " → ") +
            (target.querySelector("span")?.textContent || wire.targetPath),
        },
      ];
    }),
  );
  renderPipelineConnections(
    canvas.querySelector("svg"),
    view.edges,
    view.diagramWidth,
    view.diagramHeight,
    (wire) => view.wireSelected(wire),
  );
}
