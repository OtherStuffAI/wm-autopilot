import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { SigningPolicyDocument, SigningPolicyHistoryEntry } from "./signing-policy-registry";

export interface SigningPolicyEnvelope {
  version: 1;
  policies: SigningPolicyDocument[];
  history: SigningPolicyHistoryEntry[];
}

export interface SigningPolicyStore {
  load(): SigningPolicyEnvelope;
  save(envelope: SigningPolicyEnvelope): void;
}

export class FileSigningPolicyStore implements SigningPolicyStore {
  constructor(private readonly filePath: string) {}

  load(): SigningPolicyEnvelope {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as SigningPolicyEnvelope;
      if (parsed?.version !== 1 || !Array.isArray(parsed.policies) || !Array.isArray(parsed.history)) {
        throw new Error("unsupported signing policy store format");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, policies: [], history: [] };
      throw new Error(`Failed to load signing policies: ${(error as Error).message}`);
    }
  }

  save(envelope: SigningPolicyEnvelope): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600, flag: "w" });
    renameSync(temporary, this.filePath);
    chmodSync(this.filePath, 0o600);
  }
}
