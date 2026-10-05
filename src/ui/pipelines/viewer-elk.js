export function portId(key, side, path) { return JSON.stringify([key, side, path]); }
export function elkGraph(cards, links, direction) {
  const ports = new Set(cards.flatMap(card => card.ports.map(port => port.id)));
  return {
    id: "pipeline", layoutOptions: {
      "elk.algorithm": "layered", "elk.direction": direction,
      "elk.separateConnectedComponents": "true",
      "elk.aspectRatio": direction === "DOWN" ? "0.1" : "3",
      "elk.layered.considerModelOrder.components": "MODEL_ORDER",
      "elk.layered.nodePlacement.strategy": direction === "DOWN" ? "SIMPLE" : "BRANDES_KOEPF",
      "elk.edgeRouting": "ORTHOGONAL", "elk.padding": "[top=24,left=24,bottom=24,right=24]",
      "elk.spacing.nodeNode": "60", "elk.layered.spacing.nodeNodeBetweenLayers": "100",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.spacing.edgeNode": "24", "elk.spacing.edgeLabel": "12",
    },
    children: cards.map(card => ({id: card.key, width: card.width, height: card.height,
      layoutOptions: {"elk.portConstraints": "FIXED_POS"}, ports: card.ports})),
    edges: links.map((link, index) => {
      const source = portId(link.sourceKey, "outputs", link.sourcePath), target = portId(link.targetKey, "inputs", link.targetPath);
      if (!ports.has(source) || !ports.has(target)) throw new Error(`Exact field port unavailable: ${link.sourcePath} → ${link.targetPath}`);
      const label = `${link.sourcePath} → ${link.targetPath}`;
      return {id: String(index), sources: [source], targets: [target], labels: [{text: label, width: direction === "DOWN" ? 24 : label.length * 6.5 + 12, height: direction === "DOWN" ? label.length * 6.5 + 12 : 18}]};
    }),
  };
}
// The generation gate also invalidates layouts after scope changes or teardown.
export function createElkLayout(engine, loadEngine = async () => {
  const { default: ELK } = await import("./elk-bundle.js");
  return new ELK();
}) {
  let generation = 0, disposed = false, loading;
  return {
    async layout(graph) {
      const current = ++generation;
      try {
        if (!engine) {
          loading ||= loadEngine().catch(error => { loading = null; throw error; });
          engine = await loading;
        }
        if (disposed || current !== generation) return null;
        const result = await engine.layout(graph);
        return disposed || current !== generation ? null : result;
      } catch (error) {
        if (disposed || current !== generation) return null;
        throw error;
      }
    },
    invalidate() { generation++; },
    dispose() { disposed = true; generation++; if (engine && (!engine.worker || typeof engine.worker.worker?.terminate === "function")) engine.terminateWorker?.(); },
  };
}
