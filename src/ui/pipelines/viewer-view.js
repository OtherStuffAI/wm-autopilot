import { focusViewerDrawer } from "./viewer-accessibility.js";
import { createReviewGeometry } from "./viewer-review-geometry.js";
import { connectedPorts, viewerMapping } from "./viewer-mapping.js";
import {
  scopedPipelineNodes,
  flattenPipelineNodes,
  evidenceText,
  evidencePreview,
  portSelection,
  portPreviewSelection,
  latestPortReference,
  wiringEndpoints,
  matchingWires,
  diagramPorts,
} from "./viewer-projection.js";
import {
  createNativeViewerSession,
  REDACTION_REASON,
  REDACTION_MESSAGE,
} from "./viewer-session.js";
import { createNativeViewerStore } from "./viewer-store.js";
import { createViewerValues } from "./viewer-values.js";
import { createReviewView } from "./viewer-review-view.js";
export function createNativeViewerView({ route, ...deps }) {
  const geometry = createReviewGeometry();
  let service,
    store,
    subscription,
    observer,
    timer,
    destroyed = false,
    geometryQueued = false;
  let selectedRef = null,
    returnFocus = null,
    restoringFocus = false;
  let identityListener, logoutListener, actor;
  const view = {
    reason: null,
    status: "loading",
    snapshot: null,
    mode: route.section === "runs" ? "run" : "definition",
    selectedRunId: route.section === "runs" ? route.id : "",
    selectedDefinitionId: route.section === "definitions" ? route.id : "",
    parentTrail: [],
    scopeTrail: [],
    pinned: false, inspector: null,
    inspectLabel: "",
    inspectPath: "", inspectSide: "",
    inspectExecutionId: "", inspectEvidenceId: "",
    preview: "",
    search: "", notice: "",
    previewRevision: 0,
    recordPage: 1,
    edges: [],
    layoutError: "",
    diagramWidth: 0, diagramHeight: 0,
    init() {
      actor = globalThis.wingmanIdentityUI?.getState?.().npub;
      logoutListener = () => this.loseAccess();
      identityListener = (event) => {
        if (!event.detail?.authenticated || event.detail.npub !== actor)
          this.loseAccess();
      };
      window.addEventListener("wingman:identity-logout", logoutListener);
      window.addEventListener("wingman:identity-ui-state", identityListener);
      store = createNativeViewerStore();
      service = createNativeViewerSession({
        publish: (record) => store.publish(record),
        ...deps,
        changed: () => {
          if (destroyed) return;
          this.previewRevision++;
          this.inspector = selectedRef ? service.value(selectedRef.id) : null;
        },
      });
      subscription = store.observe((record) => {
        this.status = record.status;
        this.reason = record.reason;
        this.snapshot = record.snapshot;
        if (record.functionDetail !== undefined && this.selectedStepKey === record.reviewKey) { this.functionDetail = record.functionDetail; this.functionStatus = record.functionStatus; }
        if (["denied", "unavailable"].includes(this.status)) {
          this.closeInspector();
          this.parentTrail = []; this.scopeTrail = [];
        }
        this.queueGeometry();
      });
      observer = new ResizeObserver(() => this.queueGeometry());
      observer.observe(this.$el);
      const viewport = this.$el.querySelector(".pipeline-viewer-scroll");
      if (viewport) observer.observe(viewport);
      void service.select(this.mode, route.id);
      timer = setInterval(() => {
        if (this.$el.isConnected && this.mode === "run") void service.refresh();
      }, 2500);
    },
    destroy() {
      window.removeEventListener("wingman:identity-logout", logoutListener);
      window.removeEventListener("wingman:identity-ui-state", identityListener);
      destroyed = true;
      geometry.dispose();
      clearInterval(timer);
      observer?.disconnect();
      subscription?.unsubscribe();
      service?.dispose();
      void store?.dispose();
      this.clearRecords();
      selectedRef = null;
      returnFocus = null;
      this.snapshot = null;
      this.inspector = null;
      this.preview = "";
    },
    loseAccess() {
      service?.dispose();
      this.closeInspector();
      this.snapshot = null;
      geometry.dispose();
      this.parentTrail = []; this.scopeTrail = [];
      this.status = "denied";
      void store?.publish({
        status: "denied",
        snapshot: null,
        reason: "Owner identity changed",
      });
    },
    queueGeometry() {
      if (geometryQueued || destroyed) return;
      geometryQueued = true;
      const measure = () => {
        const run = () => {
          geometryQueued = false;
          this.measureConnections();
        };
        if (globalThis.requestAnimationFrame) requestAnimationFrame(run);
        else run();
      };
      if (this.$nextTick) this.$nextTick(measure);
      else queueMicrotask(measure);
    },
    publishReview(record) { return store?.publish({ status: this.status, reason: this.reason, snapshot: this.snapshot, reviewKey: this.selectedStepKey, ...record }); },
    measureConnections() { void geometry.measure(this); },
    get mapping() { return viewerMapping(this.nodes, this.wires, !!this.scopeTrail.length, new Set(flattenPipelineNodes(this.definition?.steps || []).map(node => node.logicalKey))); },
    get diagramNodes() { return this.nodes; },
    get definition() { return this.snapshot?.definition; },
    get nodes() {
      return scopedPipelineNodes(this.definition, this.mode === "run" ? this.snapshot : null, this.scopeTrail);
    },
    openScope(node) {
      this.closeInspector();
      this.scopeTrail = [...this.scopeTrail, { key: node.logicalKey, title: node.title || node.name }];
    },
    backScope() {
      this.closeInspector();
      this.scopeTrail = this.scopeTrail.slice(0, -1);
    },
    get wires() { return this.definition?.wiring || []; },
    get transformedWires() { return this.wires.filter((wire) => !wire.carriedForward); },
    get carriedWires() { return this.wires.filter((wire) => wire.carriedForward); },
    get statusMessage() {
      if (this.reason === REDACTION_REASON) return REDACTION_MESSAGE;
      if (this.status === "unavailable")
        return `Pipeline viewer unavailable: ${this.reason || "record or capability unavailable"}`;
      return (
        {
          loading: "Loading pipeline viewer…",
          denied: "Pipeline viewer access denied.",
          ready: "Pipeline viewer ready.",
        }[this.status] || this.status
      );
    },
    wireLabel(wire) {
      const name = (key) =>
        key
          ? this.nodes.find((node) => node.logicalKey === key)?.title || key
          : "Pipeline input";
      return `${name(wire.sourceStepKey)} · ${wire.sourcePath} → ${name(wire.targetStepKey)} · ${wire.targetPath}`;
    },
    wireSelected(wire) {
      if (this.selectedStepKey && !this.inspectPath) return this.selectedLinks.some(link => link.wire === wire);
      if (this.inspectLabel === "@scope-input") return this.mapping.links.some(link => link.wire === wire && link.sourceKey === this.inspectLabel && link.sourcePath === this.inspectPath);
      return (
        matchingWires(
          [wire],
          this.inspectLabel,
          this.inspectPath,
          this.inspectSide,
        ).length > 0
      );
    },
    async inspectWire(wire, event) {
      const side = wire.sourceStepKey ? "outputs" : "inputs",
        node = this.nodes.find(
          (row) =>
            row.logicalKey === (wire.sourceStepKey || wire.targetStepKey),
        ),
        port = node
          ? diagramPorts(node, side, [wire]).find(
              (row) =>
                row.path ===
                wiringEndpoints(wire)[0][
                  side === "outputs" ? "sourcePath" : "targetPath"
                ],
            )
          : null;
      if (port) await this.inspectPort(node, side, port, event, true);
    },
    ports(node, side) { return node.inputNode ? node[side] : connectedPorts(node, side, this.mapping.wires); },
    async navigateSelection(id, mode, trail = []) {
      this.closeInspector();
      this.scopeTrail = [];
      this.mode = mode;
      this.parentTrail = trail;
      this.selectedRunId = mode === "run" ? id : "";
      this.selectedDefinitionId = mode === "definition" ? id : "";
      await service.select(mode, id);
    },
    async openChild(step) {
      if (step.childRunId)
        await this.navigateSelection(step.childRunId, "run", [
          ...this.parentTrail,
          {
            id: this.selectedRunId,
            title: this.snapshot?.run.name || "Parent run",
          },
        ]);
    },
    async backToParent() {
      const trail = [...this.parentTrail],
        parent = trail.pop();
      if (parent) await this.navigateSelection(parent.id, "run", trail);
    },
    deliveryPreview(step) {
      void this.previewRevision;
      const ref = step.evidence
        .filter((row) => row.kind === "side_effect_confirmation")
        .at(-1);
      const preview = ref ? service?.preview?.(ref.id) : null;
      if (!preview) return "";
      const value = preview.value;
      return typeof value === "string" ? value.slice(0, 90)
        : value?.delivery?.status || value?.status || "Captured confirmation · inspect execution evidence";
    },
    deliveryLink(step) {
      void this.previewRevision;
      const ref = step.evidence
          .filter((row) => row.kind === "side_effect_confirmation")
          .at(-1),
        preview = ref ? service?.preview?.(ref.id) : null;
      if (!preview || preview.truncated || preview.value?.delivered !== true)
        return "";
      try {
        const url = new URL(preview.value?.url || preview.value?.link);
        return ["http:", "https:"].includes(url.protocol) ? url.href : "";
      } catch {
        return "";
      }
    },
    async retry() {
      await service?.refresh();
    },
    portPreview(node, side, port) {
      void this.previewRevision;
      if (node.inputNode) return "Source";
      const step = node.attempts.at(-1),
        ref = this.portReference(step, side, port),
        cached = ref ? service?.value(ref.id) : null;
      if (cached?.status === "ready") {
        const selected = portSelection(cached.value, port.path);
        return selected.status === "missing"
          ? "Selected field is missing"
          : selected.status === "null"
            ? "Explicit null"
            : evidencePreview(selected.value);
      }
      if (this.mode === "definition") return port.configured ? "Mapped field" : port.format || "Configured field";
      const preview = ref ? service?.preview?.(ref.id) : null;
      if (!preview)
        return ref?.availability === "not_captured"
          ? "Not captured"
          : "Bounded preview unavailable";
      const selected = portPreviewSelection(preview, port.path);
      if (selected.status === "outside") return "Field outside bounded preview";
      if (selected.status === "missing") return "Selected field is missing";
      return `${selected.count != null ? selected.count + " records · " : ""}${selected.status === "null" ? "Explicit null" : evidenceText(selected.value).slice(0, 90)}${selected.truncated ? " · bounded excerpt" : " · bounded preview"}`;
    },
    portReference: latestPortReference,
    async inspectPort(node, side, port, event, pin = false, execution = null) {
      if (restoringFocus || (this.pinned && !pin)) return;
      if (pin && this.selectedStepKey !== node.logicalKey) { this.selectedStepKey = ""; this.functionDetail = null; this.functionStatus = ""; }
      returnFocus = event?.currentTarget || returnFocus;
      this.inspectPath = port.path;
      this.inspectLabel = node.logicalKey;
      this.inspectSide = side;
      const step = execution || node.attempts.at(-1),
        ref = this.portReference(step, side, port);
      this.inspectExecutionId = step?.id || "";
      this.inspectEvidenceId = ref?.id || "";
      if (ref && pin) await this.inspect(ref, event, true, true);
      else if (ref) {
        selectedRef = null;
        this.inspector = null;
        this.preview = this.portPreview(node, side, port);
        returnFocus = event?.currentTarget || returnFocus;
      } else {
        this.inspector = null;
        selectedRef = null;
        this.preview =
          this.mode === "definition"
            ? `${port.label} · ${port.format || "auto"} field. Selects ${port.path} from ${node.inputNode ? "pipeline/scope input" : side === "inputs" ? "resolved step input" : "returned step output"}. No execution value exists in definition mode.`
            : node.inputNode ? `Source selector ${port.path}. Inspect the receiving step’s captured input for execution values.` : "Not captured for this attempt.";
        this.pinned = pin;
        if (pin) focusViewerDrawer(this);
      }
    },
    async inspect(ref, event, pin = true, port = false) {
      if (restoringFocus || (this.pinned && !pin)) return;
      if (!pin) {
        this.preview = evidencePreview(service?.preview(ref.id)?.value);
        return;
      }
      if (!port) {
        this.inspectPath = "";
        this.inspectLabel = "";
        this.inspectSide = "";
        this.inspectExecutionId = ref.stepId;
        this.inspectEvidenceId = ref.id;
      }
      service?.clearValues();
      selectedRef = ref;
      returnFocus = event?.currentTarget || returnFocus;
      this.pinned = pin;
      focusViewerDrawer(this);
      this.clearRecords();
      this.recordPage = 1;
      this.search = "";
      this.notice = "";
      this.inspector = service?.value(ref.id);
      await service?.evidence(ref);
    },
    async moreEvidence() { if (selectedRef) await service?.evidence(selectedRef, true); },
    closeInspector() {
      this.selectedStepKey = "";
      this.functionDetail = null; this.functionStatus = "";
      this.reviewReturnFocus?.focus?.(); this.reviewReturnFocus = null;
      this.clearRecords();
      this.recordPage = 1;
      selectedRef = null;
      this.inspector = null;
      this.preview = "";
      this.pinned = false;
      this.search = "";
      this.inspectPath = "";
      this.inspectLabel = "";
      this.inspectSide = "";
      this.inspectExecutionId = ""; this.inspectEvidenceId = "";
      service?.clearValues();
      restoringFocus = true;
      returnFocus?.focus?.();
      restoringFocus = false;
      returnFocus = null;
    },
    async copyRecord(record) {
      try {
        await (deps.clipboard || navigator.clipboard).writeText(record.text);
        this.notice = "Loaded record copied.";
      } catch {
        this.notice = "Copy unavailable. Select the exact text to copy.";
      }
    },
    async copy() {
      if (this.fieldStatus === "missing") {
        this.notice = "Selected field is missing from retained evidence.";
        return;
      }
      if (!this.inspector?.complete) {
        this.notice = "Load the complete retained value before copying.";
        return;
      }
      try {
        await (deps.clipboard || navigator.clipboard).writeText(this.valueText);
        this.notice = "Complete retained value copied.";
      } catch {
        this.notice = "Copy unavailable. Select the exact text to copy.";
      }
    },
  };
  Object.defineProperties(
    view,
    Object.getOwnPropertyDescriptors(createViewerValues()),
  );
  Object.defineProperties(view, Object.getOwnPropertyDescriptors(createReviewView()));
  return view;
}
