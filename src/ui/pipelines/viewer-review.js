
export function stepType(node) {
  return ({ code: "Code", agent: "Agent", classifier: "Decision", loop: "Loop",
    pipeline: "Child pipeline", parallel: "Parallel", block: "Block" })[node.type] || node.type || "Recorded step";
}
export function conditionLabel(condition, nodes) {
  if (!condition) return "";
  if (typeof condition.path !== "string") return "Configured condition (see details)";
  let label = condition.path;
  for (const node of nodes) {
    const assign = node.review?.assign;
    if (!assign || !condition.path.startsWith(assign + ".")) continue;
    const path = "$" + condition.path.slice(assign.length);
    label = node.outputs.find(port => port.path === path)?.label || condition.path;
  }
  if (label === condition.path) {
    const parts = condition.path.replace(/^\$\.?/, "").split(".");
    label = parts.slice(-2).join(" ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
  }
  const value = JSON.stringify(condition.equals);
  if (label.length > 48 || !value || value.length > 40) return "Configured condition (see details)";
  return `${label} is ${value}`;
}
// Conditions gate sequential steps; a classifier alone is not a branch. Skip
// edges bypass the actual contiguous gated range, never invent outcome nodes.
export function executionFlow(nodes) {
  const links = [], loops = [], unavailable = [];
  function link(source, target, label = "", kind = "execution") {
    if (source && target) links.push({ sourceKey: source.logicalKey, targetKey: target.logicalKey, label, kind });
  }
  nodes.forEach((node, index) => {
    const next = nodes[index + 1], config = node.review;
    link(node, next, next?.review?.when ? conditionLabel(next.review.when, nodes) : "");
    const condition = config?.when;
    if (condition && index && JSON.stringify(nodes[index - 1].review?.when) !== JSON.stringify(condition)) {
      let end = index;
      while (end + 1 < nodes.length && JSON.stringify(nodes[end + 1].review?.when) === JSON.stringify(condition)) end++;
      link(nodes[index - 1], nodes[end + 1], "Otherwise · skip " + (end - index + 1), "skip");
    }
    if (node.type === "loop" && config) {
      const target = config.target ? nodes.find(row => row.name === config.target || row.review?.id === config.target) : node;
      if (!target) unavailable.push(`Loop target unavailable: ${config.target}`);
      else {
        const start = nodes.indexOf(target);
        loops.push({ key: node.logicalKey, keys: nodes.slice(Math.min(start, index), index + 1).map(row => row.logicalKey),
          label: `${node.title} · ${config.iterations ?? 1} iterations${config.history ? " · collect " + config.history : ""}` });
        if (config.target) link(node, target, `Repeat until ${config.iterations ?? 1} iterations`, "repeat");
      }
      if (next) links.find(row => row.sourceKey === node.logicalKey && row.targetKey === next.logicalKey).label = "Bound reached" + (next.review?.when ? " · " + conditionLabel(next.review.when, nodes) : "");
    }
  });
  return { links, loops, unavailable };
}
export function domainPorts(node, side) {
  return (node[side] || []).filter(port => !port.configured);
}
export function selectedMappingLinks(mapping, key, path, side) {
  if (!key) return [];
  const related = (candidate) => candidate === path || candidate.startsWith(path + ".") || path.startsWith(candidate + ".") || candidate === "$";
  return mapping.links.filter(link => path
    ? side === "outputs" ? link.sourceKey === key && related(link.sourcePath)
      : link.targetKey === key && related(link.targetPath)
    : link.sourceKey === key || link.targetKey === key);
}
export function reviewValidation(node, nodes) {
  if (!node.review) return ["Control and configuration unavailable in this server summary. Activation of the review metadata is required."];
  const messages = [];
  if (node.type === "loop" && node.review.target && !nodes.some(row => row.name === node.review.target || row.review?.id === node.review.target)) messages.push("Loop target is missing from this scope.");
  if (!node.description) messages.push("No purpose is declared.");
  if (!node.inputs.length && !node.outputs.length) messages.push("No domain display fields are declared.");
  return messages.length ? messages : ["Review structure available. This is not an executor validation or a claim of successful execution."];
}
