import type { JsonObject } from "../pipeline-store";

export interface CliArgument {
  kind: "number" | "handle" | "query";
  description: string;
  default?: number;
  min?: number;
  max?: number;
}
export interface CliContract {
  id: string;
  readOnly: true;
  operations: Record<string, string>;
  arguments: Record<string, CliArgument>;
  required: Record<string, string[]>;
  applicable: Record<string, string[]>;
  defaultOperation: string;
  policy: string;
  explicitSources: Record<string, string>;
  argv: (operation: string, args: Record<string, string | number>) => string[];
}
export interface Candidate { value: string | number; span: string }
export interface CliSelection { operation: string; args: Record<string, string | number>; downstream: string; downstreamCount?: number }
export interface CliInterpretation {
  request: string; contractId: string; candidates: Record<string, Candidate[]>;
  selection: CliSelection | null; verdict: "ready" | "fallback" | "needs_clarification" | "unsupported" | "blocked";
  reason: string; disclosures: string[]; modelCalls: number; usage: JsonObject[]; startedAt: number;
}
const contracts = new Map<string, CliContract>();
export function registerCliContract(contract: CliContract): void {
  if (!contract.readOnly || !contract.operations[contract.defaultOperation]) throw new Error("invalid_cli_contract");
  if (contracts.has(contract.id)) throw new Error("duplicate_cli_contract");
  contracts.set(contract.id, contract);
}
export function cliContract(id: string): CliContract {
  const contract = contracts.get(id);
  if (!contract) throw new Error("unregistered_cli_contract");
  return contract;
}
