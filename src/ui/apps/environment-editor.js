export function buildManagedEnvironmentPayload(rows) {
  const env = [];
  for (const row of rows) {
    const key = typeof row?.key === "string" ? row.key.trim() : "";
    const value = typeof row?.value === "string" ? row.value : "";
    const existing = row?.existing === true;
    if (!key && !value) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable key: ${key || "(blank)"}`);
    }
    env.push(existing && value.length === 0 ? { key, retain: true } : { key, value });
  }
  return env;
}
