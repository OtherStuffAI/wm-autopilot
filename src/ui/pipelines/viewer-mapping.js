import { diagramPorts, wiringEndpoints } from "./viewer-projection.js";

export const INPUT_KEY = "@scope-input";
// Only exact wiring selectors become connected fields. A friendly metadata
// label is reserved for the explicitly named chatMetadata path.
export function connectedPorts(node, side, wires) {
  return diagramPorts(node, side, wires).map(port => ({
    ...port,
    label: port.configured && port.path === "$.chatMetadata" ? "Chat metadata" : port.label,
  }));
}
function validSelector(path) {
  return typeof path === "string" && /^\$(?:(?:\.[A-Za-z_][\w-]*)|(?:\[(?:\d+|"[^"\\]*"|'[^'\\]*')\]))*$/.test(path);
}
export function viewerMapping(nodes, wiring, nested = false, knownKeys = new Set(nodes.map(node => node.logicalKey))) {
  const keys = new Set(nodes.map(node => node.logicalKey));
  const wires = wiring.filter(wire => keys.has(wire.targetStepKey));
  const inputs = new Map();
  const links = [], unavailable = wiring.filter(wire => !knownKeys.has(wire.targetStepKey)).map(wire => `Unavailable target step: ${wire.targetStepKey} · ${wire.targetPath}`);
  for (const wire of wires) {
    if (wire.sourceStepKey && !knownKeys.has(wire.sourceStepKey)) {
      unavailable.push(`Unavailable source step: ${wire.sourceStepKey} · ${wire.sourcePath} → ${wire.targetPath}`);
      continue;
    }
    if (![wire.sourceValuePath || wire.sourcePath, wire.sourcePath, wire.targetPath].every(validSelector)) {
      unavailable.push(`Unavailable mapping: ${wire.sourcePath} → ${wire.targetPath}`);
      continue;
    }
    for (const endpoint of wiringEndpoints(wire)) {
      if (![endpoint.sourcePath, endpoint.targetPath].every(validSelector)) {
        unavailable.push(`Unavailable mapping: ${wire.sourcePath} → ${wire.targetPath}`);
        continue;
      }
      const external = !wire.sourceStepKey || !keys.has(wire.sourceStepKey);
      const sourcePath = external ? wire.sourcePath + endpoint.sourcePath.slice((wire.sourceValuePath || wire.sourcePath).length) : endpoint.sourcePath;
      if (external) inputs.set(sourcePath, {path: sourcePath, label: sourcePath, format: "Scope selector", configured: true});
      links.push({ wire, sourceKey: external ? INPUT_KEY : wire.sourceStepKey,
        sourcePath, targetKey: wire.targetStepKey, targetPath: endpoint.targetPath });
    }
  }
  for (const node of nodes) {
    for (const port of node.inputs || []) {
      if (!links.some(link => link.targetKey === node.logicalKey && link.targetPath === port.path))
        unavailable.push(`Mapping unavailable: ${node.title || node.logicalKey} · ${port.path} has no exact source selector in the captured definition.`);
    }
  }
  const input = {logicalKey: INPUT_KEY, title: nested ? "Scope input" : "Pipeline input", description: "Configured source fields · execution values are inspected on receiving steps.", inputs: [], outputs: [...inputs.values()], children: [], attempts: [], inputNode: true};
  return {nodes: inputs.size ? [input, ...nodes] : nodes, wires: [...new Set(links.map(link => link.wire))], links, unavailable};
}
