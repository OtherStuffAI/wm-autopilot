// Roles describe this step's use of data, independently of selector provenance.
export function declaredPort(node, side, path) {
  return (node?.[side] || []).filter(port => path === port.path || path.startsWith(port.path + ".") || path.startsWith(port.path + "["))
    .sort((a, b) => b.path.length - a.path.length)[0];
}
export function mappingRole(link, nodes) {
  const port = declaredPort(nodes.find(node => node.logicalKey === link.targetKey), "inputs", link.targetPath);
  return port?.source && port.source !== "input" ? "unclassified" : port?.role || "unclassified";
}
export function operationLinks(mapping, nodes) {
  return mapping.links.filter(link => mappingRole(link, nodes) === "operation");
}
export function rolePorts(ports, role) {
  return ports.filter(port => role === "unclassified" ? !port.role : port.role === role);
}
export function dataConnectionGroups(links, nodes) {
  const groups = new Map();
  for (const link of links) {
    const key = link.sourceKey + "→" + link.targetKey;
    const target = nodes.find(node => node.logicalKey === link.targetKey);
    const source = nodes.find(node => node.logicalKey === link.sourceKey);
    const input = declaredPort(target, "inputs", link.targetPath);
    const output = declaredPort(source, "outputs", link.sourcePath);
    const provenance = output?.role === "carried" || output?.source === "input" || output?.source === "state" ? "Context via " : "";
    if (!groups.has(key)) groups.set(key, { key, sourceKey: link.sourceKey, targetKey: link.targetKey,
      sourceLabel: provenance + (source?.title || (link.sourceKey === "@scope-input" ? "Pipeline input" : link.sourceKey)), links: [], labels: [] });
    const group = groups.get(key);
    group.links.push(link);
    const label = input?.label || link.targetPath;
    if (!group.labels.includes(label)) group.labels.push(label);
  }
  return [...groups.values()].map(group => {
    const order = nodes.find(node => node.logicalKey === group.targetKey)?.inputs || [];
    group.labels.sort((a, b) => order.findIndex(port => port.label === a) - order.findIndex(port => port.label === b));
    return group;
  });
}
