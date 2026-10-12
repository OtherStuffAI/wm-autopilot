// Shared renderer logic adapted from the reviewed Flight Deck viewer.
const SVG = "http://www.w3.org/2000/svg";
// SVG <template> is not an HTMLTemplateElement; render measured links natively.
// Untrusted field labels are always textContent, never markup.
export function renderPipelineConnections(svg, edges, width, height, selected) {
  if (!svg) return;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  for (const group of svg.querySelectorAll("g")) group.remove();
  for (const edge of edges) {
    const group = document.createElementNS(SVG, "g");
    group.dataset.testid = `pipeline-wire-${edge.index}`;
    group.dataset.highlighted = String(selected(edge.wire));
    group.dataset.kind = edge.kind || "data";
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", edge.path);
    path.setAttribute("marker-end", "url(#pipeline-arrow)");
    if (edge.wire.carriedForward || ["skip", "repeat", "data"].includes(edge.kind)) path.setAttribute("stroke-dasharray", "6 4");
    const label = document.createElementNS(SVG, "text");
    label.setAttribute("x", String(edge.labelX));
    label.setAttribute("y", String(edge.labelY));
    label.setAttribute("text-anchor", "middle");
    if (edge.verticalLabel) label.setAttribute("transform", `rotate(-90 ${edge.labelX} ${edge.labelY})`);
    label.textContent = edge.label;
    group.append(path, label);
    svg.append(group);
  }
}
