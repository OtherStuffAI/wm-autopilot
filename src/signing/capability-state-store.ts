import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { CapabilityBrokerStateStore, PersistedCapabilityRecord } from "./capability-broker";

interface CapabilityStateEnvelope {
  version: 1;
  records: PersistedCapabilityRecord[];
}

export class FileCapabilityBrokerStateStore implements CapabilityBrokerStateStore {
  constructor(private readonly filePath: string) {}

  load(): PersistedCapabilityRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as CapabilityStateEnvelope;
      return parsed?.version === 1 && Array.isArray(parsed.records) ? parsed.records : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`Failed to load capability broker state: ${(error as Error).message}`);
    }
  }

  save(records: PersistedCapabilityRecord[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, records } satisfies CapabilityStateEnvelope)}\n`, {
      mode: 0o600,
      flag: "w",
    });
    renameSync(temporary, this.filePath);
    chmodSync(this.filePath, 0o600);
  }
}
