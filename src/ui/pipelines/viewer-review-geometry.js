import { createElkLayout } from "./viewer-elk.js";
import { renderPipelineConnections } from "./viewer-diagram.js";

export function reviewGraph(cards, links, direction = "DOWN") {
  const keys = new Set(cards.map(card => card.key));
  return {
    id: "review", layoutOptions: {
      "elk.algorithm": "layered", "elk.direction": direction,
      "elk.edgeRouting": "ORTHOGONAL", "elk.padding": "[top=54,left=28,bottom=40,right=28]",
      "elk.spacing.nodeNode": "28", "elk.layered.spacing.nodeNodeBetweenLayers": "84",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
      "elk.layered.nodePlacement.strategy": "SIMPLE",
    },
    children: cards.map(card => ({ id: card.key, width: card.width, height: card.height })),
    edges: links.filter(link => keys.has(link.sourceKey) && keys.has(link.targetKey)).map((link, index) => ({
      id: String(index), sources: [link.sourceKey], targets: [link.targetKey],

    })),
  };
}
export function createReviewGeometry() {
  const layout = createElkLayout();
  let signature = "", result = null, generation = 0, observer;
  const observed = new Set();
  return {
    dispose() { generation++; layout.dispose(); observer?.disconnect(); observed.clear(); result = null; },
    async measure(view) {
      const canvas = view.$el?.querySelector(".pipeline-viewer-canvas");
      if (!canvas) return;
      const elements = [...canvas.querySelectorAll(".pipeline-viewer-step")];
      if (!elements.length || elements.length !== view.nodes.length) return;
      observer ||= new ResizeObserver(() => view.queueGeometry());
      for (const element of observed) if (!elements.includes(element)) { observer.unobserve(element); observed.delete(element); }
      for (const element of elements) if (!observed.has(element)) { observer.observe(element); observed.add(element); }
      const cards = elements.map(element => ({ key: element.dataset.nodeKey, width: element.offsetWidth, height: element.offsetHeight }));
      const graph = reviewGraph(cards, view.flow.links, "DOWN");
      const next = JSON.stringify(graph), ticket = ++generation;
      try {
        if (signature !== next || !result) {
          result = null; signature = next;
          const measured = await layout.layout(graph);
          if (!measured || ticket !== generation || !canvas.isConnected) return;
          result = measured;
        }
        if (!result) return;
        const positions = new Map(result.children.map(node => [node.id, node]));
        for (const element of elements) {
          const node = positions.get(element.dataset.nodeKey);
          element.style.left = node.x + "px"; element.style.top = node.y + "px";
        }
        const edges = result.edges.flatMap(edge => (edge.sections || []).map(section => {
          const link = view.flow.links[Number(edge.id)];
          const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
          const segments = points.slice(1).map((point, index) => ({ start: points[index], end: point }));
          const segment = segments.sort((a, b) => (Math.abs(b.end.x-b.start.x)+Math.abs(b.end.y-b.start.y)) - (Math.abs(a.end.x-a.start.x)+Math.abs(a.end.y-a.start.y)))[0];
          return { wire: link, kind: link.kind, index: "execution-" + edge.id,
            path: points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" "),
            label: link.kind === "execution" && link.label ? (link.label.startsWith("Bound reached") ? "Bound reached" : "Condition met") : link.label,
            verticalLabel: ["repeat", "skip"].includes(link.kind) && segment.start.x === segment.end.x,
            labelX: ["repeat", "skip"].includes(link.kind) && segment.start.x === segment.end.x ? Math.max(14, segment.start.x - 10) : Math.max(link.label.length * 3 + 4, Math.min(result.width - link.label.length * 3 - 4, (segment.start.x + segment.end.x) / 2)),
            labelY: (segment.start.y + segment.end.y) / 2 - (["repeat", "skip"].includes(link.kind) && segment.start.x === segment.end.x ? 0 : 10) };
        }));
        // Field inspection is an overlay: selection never changes card positions.
        view.diagramDataGroups.forEach((group, index) => {
          const link = group.links[0];
          const source = positions.get(link.sourceKey), target = positions.get(link.targetKey);
          if (!target) return;
          const start = source ? { x: source.x + source.width, y: source.y + source.height - 12 } : { x: target.x + target.width + 12, y: target.y + target.height - 32 };
          const end = { x: target.x + target.width, y: target.y + target.height - 12 };
          const laneX = Math.max(...result.children.map(node => node.x + node.width)) + 22 + index * 20;

          edges.push({ wire: link.wire, kind: "data", index: "data-" + index,
            path: `M ${start.x} ${start.y} H ${laneX} V ${end.y} H ${end.x}`,
            label: String(group.number), labelX: laneX - 3, labelY: (start.y + end.y) / 2 });
        });
        const regions = view.flow.loops.map(loop => {
          const members = loop.keys.map(key => positions.get(key)).filter(Boolean);
          const left = Math.min(...members.map(node => node.x)) - 12, top = Math.min(...members.map(node => node.y)) - 30;
          return { ...loop, left, top, width: Math.max(...members.map(node => node.x + node.width)) - left + 12,
            height: Math.max(...members.map(node => node.y + node.height)) - top + 16 };
        });
        for (const previous of canvas.querySelectorAll(".pipeline-review-loop-region")) previous.remove();
        for (const region of regions) {
          const element = document.createElement("div"); element.className = "pipeline-review-loop-region";
          element.setAttribute("aria-label", region.label); element.textContent = region.label;
          Object.assign(element.style, { left: region.left + "px", top: region.top + "px", width: region.width + "px", height: region.height + "px" });
          canvas.prepend(element);
        }
        view.diagramWidth = result.width + view.diagramDataGroups.length * 20 + 24; view.diagramHeight = result.height + view.diagramDataGroups.length * 20 + 24;
        canvas.style.width = view.diagramWidth + "px"; canvas.style.height = view.diagramHeight + "px";
        if (view.autoFit) view.zoom = Math.min(1, Math.max(0.85, (canvas.parentElement.clientWidth - 8) / result.width));
        canvas.style.transform = `scale(${view.zoom})`; canvas.style.transformOrigin = "top left";
        canvas.parentElement.style.height = Math.ceil(view.diagramHeight * view.zoom) + 18 + "px";
        const selected = elements.find(element => element.dataset.nodeKey === (view.selectedStepKey || view.inspectLabel));
        if (selected && view.pinned) {
          const node = positions.get(selected.dataset.nodeKey), viewport = canvas.parentElement;
          const top = node.y * view.zoom, bottom = (node.y + node.height) * view.zoom;
          if (top < viewport.scrollTop || bottom > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = Math.max(0, top - 20);
          viewport.scrollLeft = Math.max(0, node.x * view.zoom - 20);
        }
        view.edges = edges; view.layoutError = "";
        renderPipelineConnections(canvas.querySelector("svg"), edges, view.diagramWidth, view.diagramHeight,
          wire => wire.kind ? !view.selectionActive || [wire.sourceKey, wire.targetKey].includes(view.selectedStepKey || view.inspectLabel) : !view.selectionActive || view.wireSelected(wire));
      } catch (error) {
        result = null; signature = ""; view.edges = [];
        view.layoutError = "Layout unavailable: " + error.message;
        renderPipelineConnections(canvas.querySelector("svg"), [], 0, 0, () => false);
      }
    },
  };
}
