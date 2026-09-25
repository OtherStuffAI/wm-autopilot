import type { JsonObject } from "../pipeline-store";

export interface AudioUnderstandingAdapters {
  resolveStorage?: (input: { objectId: string; audioRef: string; route: JsonObject }) => Promise<{ path: string; metadata?: JsonObject }>;
  publishArtifacts?: (input: { artifacts: JsonObject[]; route: JsonObject }) => Promise<JsonObject[]>;
  invokeDownstream?: (input: { pipelineId: string; transcript: JsonObject; route: JsonObject }) => Promise<JsonObject>;
}

const adaptersKey = Symbol.for("wingmen.pipeline.audioUnderstandingAdapters");
type AdapterGlobal = typeof globalThis & { [adaptersKey]?: AudioUnderstandingAdapters };

export function configureAudioUnderstandingAdapters(adapters: AudioUnderstandingAdapters): void {
  (globalThis as AdapterGlobal)[adaptersKey] = adapters;
}

export function getAudioUnderstandingAdapters(): AudioUnderstandingAdapters {
  return (globalThis as AdapterGlobal)[adaptersKey] ?? {};
}
