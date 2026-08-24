import { normalizeNightWatchIntervalMinutes, normalizeNightWatchPrompt } from "./nightwatch-constants";

export interface NightWatchStartOptions {
  enabled: boolean;
  prompt?: string;
  intervalMinutes?: number;
  maxCycles?: number;
}

function parsePositiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

export function parseNightWatchStartOptions(input: unknown): NightWatchStartOptions | null {
  if (input == null || input === false) {
    return null;
  }

  if (input === true) {
    return { enabled: true };
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("nightwatch must be true, false, or an object");
  }

  const record = input as Record<string, unknown>;
  const enabled = record.enabled !== false;
  if (!enabled) {
    return { enabled: false };
  }

  const options: NightWatchStartOptions = { enabled: true };

  if (record.prompt !== undefined) {
    options.prompt = normalizeNightWatchPrompt(record.prompt);
  }

  if (record.intervalMinutes !== undefined) {
    options.intervalMinutes = normalizeNightWatchIntervalMinutes(record.intervalMinutes);
  }

  if (record.maxCycles !== undefined) {
    const maxCycles = parsePositiveInteger(record.maxCycles);
    if (maxCycles !== undefined) {
      options.maxCycles = maxCycles;
    }
  }

  return options;
}
