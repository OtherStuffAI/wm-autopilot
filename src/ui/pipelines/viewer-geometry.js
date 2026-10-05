import { renderPipelineConnections } from "./viewer-diagram.js";
import { createElkLayout, elkGraph, portId } from "./viewer-elk.js";

export function createViewerGeometry() {
  const layout = createElkLayout();
  let signature = "", resultSignature = "", result = null, requestGeometry;
  const observedCards = new Set();
  const cardObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => requestGeometry?.()) : null;
  return {
    dispose() { layout.dispose(); cardObserver?.disconnect(); observedCards.clear(); requestGeometry = null; result = null; },
    async measure(view) {
      const canvas = view.$el?.querySelector(".pipeline-viewer-canvas");
      if (!canvas) return;
      const mapping = view.mapping;
      const mobile = globalThis.innerWidth <= 850;
      const elements = [...canvas.querySelectorAll(".pipeline-viewer-step")];
      requestGeometry = () => view.queueGeometry();
      for (const card of observedCards) if (!elements.includes(card)) {
        cardObserver?.unobserve(card); observedCards.delete(card);
      }
      for (const card of elements) if (!observedCards.has(card)) {
        cardObserver?.observe(card); observedCards.add(card);
      }
      const cards = elements.map(element => {
        const rect = element.getBoundingClientRect();
        return {key: element.dataset.nodeKey, width: rect.width, height: rect.height,
          ports: [...element.querySelectorAll("[data-port-node]")].map(port => {
            const bounds = port.getBoundingClientRect(), output = port.dataset.portSide === "outputs";
            return {id: portId(element.dataset.nodeKey, port.dataset.portSide, port.dataset.portPath),
              x: output || mobile ? rect.width : 0, y: bounds.top - rect.top + bounds.height / 2,
              width: 0, height: 0, layoutOptions: {"elk.port.side": output || mobile ? "EAST" : "WEST"}};
          })};
      });
      if (!cards.length || cards.length !== mapping.nodes.length) return;
      try {
        const graph = elkGraph(cards, mapping.links, mobile ? "DOWN" : "RIGHT");
        const nextSignature = JSON.stringify(graph);
        if (nextSignature !== signature) {
          signature = nextSignature;
          view.edges = [];
          renderPipelineConnections(canvas.querySelector("svg"), [], 0, 0, () => false);
          const next = await layout.layout(graph);
          if (!next || signature !== nextSignature || !canvas.isConnected) return;
          result = next; resultSignature = nextSignature;
        }
        if (!result || resultSignature !== nextSignature) return;
        for (const node of result.children) {
          const element = elements.find(element => element.dataset.nodeKey === node.id);
          element.style.position = "absolute";
          element.style.left = node.x + "px"; element.style.top = node.y + "px";
        }
        canvas.style.width = result.width + "px"; canvas.style.height = result.height + "px";
        view.diagramWidth = result.width; view.diagramHeight = result.height;
        view.edges = result.edges.flatMap(edge => (edge.sections || []).map(section => {
          const link = mapping.links[Number(edge.id)], label = edge.labels?.[0];
          const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
          return {wire: link.wire, index: edge.id, path: points.map((p,i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" "),
            label: label?.text || "", verticalLabel: mobile, labelX: label ? label.x + label.width / 2 : 0,
            labelY: label ? label.y + (mobile ? label.height / 2 : 13) : 0};
        }));
        view.layoutError = "";
        renderPipelineConnections(canvas.querySelector("svg"), view.edges, result.width, result.height, wire => view.wireSelected(wire));
      } catch (error) {
        signature = ""; result = null; view.edges = [];
        view.layoutError = `Layout unavailable: ${error.message}`;
        renderPipelineConnections(canvas.querySelector("svg"), [], 0, 0, () => false);
      }
    },
  };
}
