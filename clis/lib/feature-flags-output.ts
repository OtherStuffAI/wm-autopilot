export function parseFlagState(value: string): "off" | "on_admin" | "on" {
  if (value === "true") return "on";
  if (value === "false") return "off";
  if (value === "off" || value === "on_admin" || value === "on") return value;
  throw new Error("Feature flag state must be off, on_admin, on, true or false");
}

interface FeatureFlagView { key: string; state: string; effectiveState: string; }
export function readFeatureFlags(payload: { flags?: unknown }): FeatureFlagView[] {
  if (!Array.isArray(payload.flags)) throw new Error("Invalid feature flags response: expected flags array");
  return payload.flags.map((flag: unknown) => {
    if (!flag || typeof flag !== "object") throw new Error("Invalid feature flag record");
    const record = flag as FeatureFlagView;
    if (typeof record.key !== "string" || !["off", "on_admin", "on"].includes(record.state) || !["off", "on"].includes(record.effectiveState)) throw new Error("Invalid feature flag record");
    return record;
  });
}
export function printFeatureFlags(flags: FeatureFlagView[]): void {
  if (!flags.length) console.log("No feature flags.");
  for (const flag of flags) console.log(`${flag.key}\t${flag.state}\teffective=${flag.effectiveState}`);
}
