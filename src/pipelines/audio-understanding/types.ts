import type { JsonObject } from "../pipeline-store";

export interface AudioCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type AudioCommandRunner = (command: string, args: string[]) => Promise<AudioCommandResult>;

export interface AudioWord extends JsonObject {
  text: string;
  start: number;
  end: number;
  confidence: number | null;
  speaker: string;
}

export interface DiarizationSegment extends JsonObject {
  speaker: string;
  start: number;
  end: number;
  confidence: number | null;
}

export interface TranscriptTurn extends JsonObject {
  speaker: string;
  start: number;
  end: number;
  text: string;
  wordIndexes: number[];
}

export interface TranscriptCorrection extends JsonObject {
  oldText: string;
  newText: string;
  reason: string;
  source: string;
  confidence: number;
  wordIndex: number;
}

export interface AudioArtifact extends JsonObject {
  kind: string;
  ref: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}
