import { operationLinks, rolePorts, dataConnectionGroups } from "./viewer-data-roles.js";
import { stepType, conditionLabel, domainPorts, executionFlow, selectedMappingLinks, reviewValidation } from "./viewer-review.js";
import { focusViewerDrawer } from "./viewer-accessibility.js";
import { flattenPipelineNodes, matchingWires, evidenceText } from "./viewer-projection.js";

export function createReviewView() {
  return {
    showAllMappings: false, selectedStepKey: "", functionDetail: null, functionStatus: "", zoom: 1, autoFit: true,
    stepType, domainPorts,
    cardPorts(node, side) { return domainPorts(node, side).slice(0, 3); },
    extraPortCount(node, side) { return Math.max(0, domainPorts(node, side).length - 3); },
    connectionSummary(group) { return group.labels.slice(0, 3).join(" · ") + (group.labels.length > 3 ? " · +" + (group.labels.length - 3) + " fields" : ""); },
    get selectedStep() { return this.nodes.find(node => node.logicalKey === this.selectedStepKey); },
    get flow() {
      const flow = executionFlow(this.nodes);
      const scope = this.scopeTrail.at(-1), parent = scope && flattenPipelineNodes(this.definition?.steps || []).find(node => node.logicalKey === scope.key);
      if (parent?.type === "loop" && parent.review && this.nodes.length) {
        flow.loops.push({ key: parent.logicalKey, keys: this.nodes.map(node => node.logicalKey), label: `${parent.title} body · ${parent.review.iterations ?? 1} iterations` });
        flow.links.push({ sourceKey: this.nodes.at(-1).logicalKey, targetKey: this.nodes[0].logicalKey, label: "Next iteration until bound", kind: "repeat" });
      }
      return flow;
    },
    get operationLinks() { return operationLinks(this.mapping, this.nodes); },
    numberDataGroups(groups) {
      const all = dataConnectionGroups(this.mapping.links, this.nodes);
      return groups.map(group => ({ ...group, number: all.findIndex(candidate => candidate.key === group.key) + 1 }));
    },
    get dataGroups() { return this.numberDataGroups(dataConnectionGroups(this.operationLinks, this.nodes)); },
    incomingData(node) { return this.dataGroups.filter(group => group.targetKey === node.logicalKey); },
    portHeading(node, side) { return (node[side] || []).some(port => port.role) ? (side === "inputs" ? "Operation inputs" : "Operation outputs") : "Unclassified display · " + side; },
    operationPorts(node, side) { return rolePorts(this.ports(node, side), "operation"); },
    carriedPorts(node, side) { return rolePorts(this.ports(node, side), "carried"); },
    unclassifiedPorts(node, side) { return rolePorts(this.ports(node, side), "unclassified"); },
    get selectedLinks() {
      const links = selectedMappingLinks(this.mapping, this.inspectLabel || this.selectedStepKey, this.inspectPath, this.inspectSide);
      // A clicked value is an explicit request to trace that exact field. Step
      // selection retains only declared operation data until all mappings opens.
      return this.showAllMappings || this.inspectPath ? links : links.filter(link => this.operationLinks.includes(link));
    },
    get selectedDataGroups() { return this.numberDataGroups(dataConnectionGroups(this.selectedLinks, this.nodes)); },
    get diagramDataGroups() { return this.selectionActive ? this.selectedDataGroups : this.dataGroups; },
    toggleMappings() { this.showAllMappings = !this.showAllMappings; this.queueGeometry(); },
    get selectionActive() { return !!(this.selectedStepKey || this.inspectLabel); },
    get reviewMessages() { return this.selectedStep ? reviewValidation(this.selectedStep, this.nodes) : []; },
    get selectedConnections() { return this.selectedDataGroups.map(group => group.number + ". " + group.sourceLabel + " → " + (this.nodes.find(node => node.logicalKey === group.targetKey)?.title || group.targetKey) + ": " + group.labels.join(", ")); },
    highlighted(node) {
      if (this.selectedStepKey && !this.inspectPath) return node.logicalKey === this.selectedStepKey || this.selectedLinks.some(link => [link.sourceKey, link.targetKey].includes(node.logicalKey));
      return this.inspectPath && (node.logicalKey === this.inspectLabel || matchingWires(this.wires, this.inspectLabel, this.inspectPath, this.inspectSide).some(wire => [wire.sourceStepKey, wire.targetStepKey].includes(node.logicalKey)));
    },
    condition(node) { return conditionLabel(node.review?.when, this.nodes); },
    purpose(node) { return node.description || (node.review?.function ? "Run " + node.review.function : "Purpose not declared"); },
    configText(node) { return node.review ? evidenceText(node.review) : "Definition details unavailable in this server summary."; },
    loopSummary(node) {
      const config = node.review;
      if (!config || node.type !== "loop") return "";
      return `${config.target ? "Repeat from " + config.target : "Repeat " + node.children.length + " body steps"} · ${config.iterations ?? 1} iterations${config.history ? " · collect " + config.history : ""}`;
    },
    failureSummary(node) {
      return node.review?.failurePolicy ? "On failure: " + node.review.failurePolicy : "";
    },
    selectStep(node, event) {
      this.closeInspector();
      this.selectedStepKey = node.logicalKey;
      this.inspectLabel = node.logicalKey;
      this.pinned = true;
      this.functionDetail = null; this.functionStatus = "";
      this.reviewReturnFocus = event?.currentTarget;
      focusViewerDrawer(this);
    },
    async loadFunction() {
      const node = this.selectedStep, name = node?.review?.function;
      if (!name) return;
      const key = node.logicalKey;
      this.functionStatus = "Loading function source…";
      try {
        const response = await fetch(`/api/pipelines/functions/${encodeURIComponent(name)}`, { credentials: "include", cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Function source unavailable");
        if (this.selectedStepKey !== key) return;
        await this.publishReview({ functionDetail: evidenceText(payload), functionStatus: "Current library source; historical runs may have used an earlier revision." });
      } catch (error) {
        if (this.selectedStepKey === key) this.functionStatus = error.message;
      }
    },
    async openDefinedChild(node) {
      const target = node.review?.pipeline, definitionId = this.definition?.id;
      if (!target) return;
      try {
        const response = await fetch(`/api/pipelines/definitions/${encodeURIComponent(target)}`, { credentials: "include", cache: "no-store" });
        const payload = await response.json();
        if (!response.ok || !payload.definition?.id) throw new Error(payload.error || "Child definition unavailable");
        if (node.review.version != null && String(payload.definition.spec?.version) !== String(node.review.version)) throw new Error("Pinned child definition version is unavailable here. Inspect the actual child run instead.");
        if (this.definition?.id === definitionId) window.location.assign(`/pipelines/definitions/${encodeURIComponent(payload.definition.id)}`);
      } catch (error) { this.notice = error.message; this.preview = error.message; this.pinned = true; focusViewerDrawer(this); }
    },
    fitView() { this.autoFit = true; this.queueGeometry(); },
    actualSize() { this.autoFit = false; this.zoom = 1; this.queueGeometry(); },
  };
}
