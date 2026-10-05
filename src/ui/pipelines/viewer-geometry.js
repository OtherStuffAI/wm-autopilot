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
    ) || [...canvas.querySelectorAll(".pipeline-viewer-step")].find((el) => el.dataset.testid === "pipeline-step-" + node);
  view.diagramWidth = canvas.scrollWidth;
  view.diagramHeight = canvas.scrollHeight;
  const cardsBottom = Math.max(
    ...[...canvas.querySelectorAll(".pipeline-viewer-step")].map(
      (card) => card.getBoundingClientRect().bottom - rect.top,
    ),
    0,
  );
  view.edges = view.wires.filter((wire) => view.wireSelected(wire)).flatMap((wire, wireIndex) =>
    wiringEndpoints(wire).flatMap((endpoint, portIndex) => {
      const index = wireIndex * 100 + portIndex;
      const source = find(wire.sourceStepKey, "outputs", endpoint.sourcePath),
        target = find(wire.targetStepKey, "inputs", endpoint.targetPath);
      if (!target || (!source && wire.sourceStepKey)) return [];
      const b = target.getBoundingClientRect(),
        a = source?.getBoundingClientRect() || { right: rect.left, top: b.top - 30, height: b.height },
        sourceCard = source?.closest(".pipeline-viewer-step")?.getBoundingClientRect(),
        targetCard = target.closest(".pipeline-viewer-step").getBoundingClientRect(),
        mobile = globalThis.innerWidth <= 850;
      const x1 = (!source && mobile ? targetCard.right + 16 : sourceCard?.right ?? a.right) - rect.left,
        y1 = a.top + a.height / 2 - rect.top,
        x2 = (mobile ? targetCard.right : targetCard.left) - rect.left,
        y2 = b.top + b.height / 2 - rect.top;
      const lane = Math.max(x1, x2) + 12 + portIndex * 8;
      const bypassY = cardsBottom + 24 + wireIndex * 24;
      return [
        {
          wire,
          index,
          path: mobile
            ? `M ${x1} ${y1} H ${lane} V ${y2} H ${x2}`
            : `M ${x1} ${y1} H ${x1 + 16} V ${bypassY} H ${x2 - 16} V ${y2} H ${x2}`,
          verticalLabel: mobile,
          labelX: mobile ? lane + 8 : (x1 + x2) / 2,
          labelY: mobile ? (y1 + y2) / 2 : bypassY - 8,
          label:
            (source?.querySelector("span")?.textContent || wire.sourcePath).slice(0, 24) +
            (wire.carriedForward ? " ⇢ carried → " : " → ") +
            (target.querySelector("span")?.textContent || wire.targetPath).slice(0, 24),
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
