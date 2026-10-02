import { createHash } from "node:crypto";
import type { DeclarativeStep, DisplayFieldSpec } from "./declarative";
import { expandPipelineBlock } from "./pipeline-blocks";
import type { PipelineDefinitionRecord } from "./pipeline-loader";
import type { PipelineRunRecord, PipelineRunSummary, PipelineStepSummary, PipelineStore } from "./pipeline-store";
import type { PipelineBlockSnapshots } from "./pipeline-block-snapshot";
import type { EvidenceReference } from "./pipeline-evidence-store";
import { redactPipelineValue } from "./pipeline-evidence-redaction";

export interface ViewerPort { label: string; path: string; format: string }
export interface ViewerDefinitionStep {
  logicalKey: string; name: string; title: string; description: string; type: string;
  inputs: ViewerPort[]; outputs: ViewerPort[]; children: ViewerDefinitionStep[];
}
export interface ViewerWiring { sourceStepKey: string | null; sourcePath: string; targetStepKey: string; targetPath: string; carriedForward: boolean; sourceValuePath: string; sourcePortPaths: string[]; targetPortPaths: string[] }
export interface ViewerDefinition {
  id: string; name: string; title: string; description: string; version: string | number | null;
  hash: string | null; availability: "complete" | "redacted" | "unavailable"; steps: ViewerDefinitionStep[]; wiring: ViewerWiring[];
}
export interface ViewerRunSummary {
  id: string; serviceId: string; definitionId: string; definitionVersion: string | number | null; definitionHash: string | null;
  name: string; status: string; startedAt: string; completedAt: string | null; parentRunId: string | null; parentStepId: string | null;
}
export interface ViewerStepSummary {
  id: string; logicalKey: string; parentStepId: string | null; attempt: number; status: string; title: string;
  description: string; kind: string; startedAt: string; completedAt: string | null; error: string | null;
  skipReason: string | null; continuationReason: string | null; exitReason: string | null; childRunId: string | null;
  itemKey: string | null; inputs: ViewerPort[]; outputs: ViewerPort[]; evidence: EvidenceReference[];
}

export function viewerDefinition(definition: PipelineDefinitionRecord & { viewerRedacted?: boolean }, pinnedHash?: string, blockExpansions?: PipelineBlockSnapshots, sanitize = redactPipelineValue): ViewerDefinition {
  const sanitized = sanitize({ spec: definition.spec, blockExpansions });
  const structural = sanitized.value as { spec: PipelineDefinitionRecord["spec"]; blockExpansions?: PipelineBlockSnapshots };
  const spec = structural.spec;
  blockExpansions = structural.blockExpansions;
  const wiring: ViewerWiring[] = [];
  let missingExpansion = false;
  function visit(steps: DeclarativeStep[], prefix = "", inheritedWriters: Array<{ path: string; key: string; ports: DisplayFieldSpec[] }> = []): ViewerDefinitionStep[] {
    const writers = [...inheritedWriters];
    return steps.map(step => {
      const logicalKey = `${prefix}${step.id ?? step.name}`;
      const paths: Array<[string, string]> = typeof step.input === "string" ? [["$", step.input]] : Object.entries(step.input?.pick ?? {});
      for (const [target, sourcePath] of paths) {
        const writer = [...writers].reverse().find(item => sourcePath === item.path || sourcePath.startsWith(`${item.path}.`));
        const sourceValuePath = writer ? `$${sourcePath.slice(writer.path.length)}` : sourcePath;
        const targetPath = target === "$" ? "$" : `$.${target}`;
        const relatedPorts = (rows: DisplayFieldSpec[], path: string) => rows.map(row => row.path).filter(port => port === path || port.startsWith(`${path}.`) || path.startsWith(`${port}.`));
        wiring.push({ sourceValuePath, sourcePortPaths: relatedPorts(writer?.ports ?? [], sourceValuePath), targetPortPaths: relatedPorts(step.display?.in ?? [], targetPath), sourceStepKey: writer?.key ?? null, sourcePath, targetStepKey: logicalKey,
          targetPath, carriedForward: !writer || writer.key !== writers.at(-1)?.key });
      }
      if (step.type === "block" && blockExpansions && !blockExpansions[logicalKey]) missingExpansion = true;
      const children = step.type === "block" ? (blockExpansions ? blockExpansions[logicalKey]?.steps ?? [] : expandPipelineBlock(step).steps) : step.type === "loop" ? step.steps ?? [] : step.type === "parallel" ? [step.step] : [];
      if (step.assign) writers.push({ path: step.assign, key: logicalKey, ports: step.display?.out ?? [] });
      return { logicalKey, name: step.name, title: step.title ?? step.name, description: step.description ?? "", type: step.type,
        inputs: ports(step.display?.in), outputs: ports(step.display?.out), children: visit(children, `${logicalKey}/`, writers) };
    });
  }
  const steps = visit(spec.steps);
  return { id: definition.id, name: definition.name, title: definition.name, description: spec.description ?? "",
    version: spec.version ?? null, hash: pinnedHash ?? createHash("sha256").update(JSON.stringify(definition.spec)).digest("hex"),
    availability: missingExpansion ? "unavailable" : (sanitized.redacted || definition.viewerRedacted) ? "redacted" : "complete", steps, wiring };
}

export function viewerRunSummary(run: PipelineRunRecord | PipelineRunSummary, store: PipelineStore, serviceId: string): ViewerRunSummary {
  const pinned = store.composition.snapshot(run.id);
  const parent = store.composition.parent(run.id);
  return { id: run.id, serviceId, definitionId: run.definitionId, definitionVersion: pinned?.definition.spec.version ?? null,
    definitionHash: pinned?.hash ?? null, name: run.name, status: run.status, startedAt: run.startedAt,
    completedAt: run.completedAt, parentRunId: parent?.parentRunId ?? null, parentStepId: parent?.parentStepId ?? null };
}

export function viewerSnapshot(runId: string, store: PipelineStore, serviceId: string) {
  const run = store.getRunSummary(runId)!;
  const pinned = store.composition.snapshot(runId);
  const definition: ViewerDefinition = pinned ? viewerDefinition(pinned.context.viewerDefinition ?? pinned.definition, pinned.hash, pinned.context.viewerBlockExpansions ?? pinned.context.blockExpansions ?? {}, store.evidence.sanitize.bind(store.evidence)) : {
    id: run.definitionId, name: run.name, title: run.name, description: "Historical definition snapshot was not captured",
    version: null, hash: null, availability: "unavailable", steps: [], wiring: [],
  };
  if (pinned?.context.viewerRedacted && definition.availability === "complete") definition.availability = "redacted";
  const children = store.composition.children(runId).map(link => viewerRunSummary(store.getRunSummary(link.childRunId)!, store, serviceId));
  const counts = new Map<string, number>();
  const summaries = store.listStepSummaries(runId);
  const steps: ViewerStepSummary[] = summaries.map(step => {
    const logicalKey = step.logicalKey ?? step.name.replace(/ #\d+/g, "").replaceAll(" / ", "/");
    const attempt = (counts.get(logicalKey) ?? 0) + 1;
    counts.set(logicalKey, attempt);
    const metadata = store.evidence.sanitize(step.metadata, [step.callbackToken ?? ""]).value as PipelineStepSummary["metadata"];
    const display = metadata?.display as { in?: DisplayFieldSpec[]; out?: DisplayFieldSpec[] } | undefined;
    store.archiveRetainedInlineEvidence(step);
    const captured = store.evidence.list(runId, step.id);
    const evidence = [...captured, ...legacyEvidence(step).filter(ref => !captured.some(entry => entry.kind === ref.kind))];
    return { itemKey: typeof (metadata?.parent as Record<string, unknown> | undefined)?.logicalKey === "string" ? String((metadata!.parent as Record<string, unknown>).logicalKey) : null, id: step.id, logicalKey, parentStepId: step.parentStepId, attempt, status: step.status,
      title: String(metadata?.title ?? metadata?.name ?? step.name), description: String(metadata?.description ?? ""), kind: step.kind,
      startedAt: step.startedAt, completedAt: step.completedAt, error: redactPipelineValue(step.error, [step.callbackToken ?? ""]).value as string | null,
      skipReason: step.status === "skipped" ? store.evidence.sanitize(step.error ?? String(metadata?.description ?? "Configured condition did not match"), [step.callbackToken ?? ""]).value as string : null,
      continuationReason: ((metadata?.controlFlow as Record<string, unknown> | undefined)?.continuationReason as string | null) ?? null,
      exitReason: ((metadata?.controlFlow as Record<string, unknown> | undefined)?.exitReason as string | null) ?? null,
      childRunId: store.composition.child(step.id)?.childRunId ?? null, inputs: ports(display?.in), outputs: ports(display?.out), evidence };
  });
  const snapshot = store.evidence.sanitize({ run: viewerRunSummary(run, store, serviceId), definition, steps, children },
    summaries.map(step => step.callbackToken ?? "")).value as { run: ViewerRunSummary; definition: ViewerDefinition; steps: ViewerStepSummary[]; children: ViewerRunSummary[] };
  const revision = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  return { ...snapshot, revision };
}

function ports(fields: DisplayFieldSpec[] = []): ViewerPort[] {
  return fields.map(field => ({ label: field.label, path: field.path, format: field.format ?? "auto" }));
}
function legacyEvidence(step: PipelineStepSummary): EvidenceReference[] {
  return (["resolved_input", "executor_request", "returned_output", "state_write", "side_effect_confirmation"] as const).map(kind => ({
    id: `not-captured:${step.id}:${kind}`, runId: step.runId, stepId: step.id, attempt: 1, kind, scope: "legacy_not_captured",
    contentType: "application/json", bytes: 0, availability: "not_captured", redacted: false, capturedAt: null, expiresAt: null,
  }));
}
