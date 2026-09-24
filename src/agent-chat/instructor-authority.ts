export function normaliseInstructorNpubs(values: Array<string | null | undefined>): string[] {
  const result = new Set<string>();
  for (const value of values) {
    const npub = value?.trim();
    if (!npub) continue;
    result.add(npub);
  }
  return [...result].sort();
}

export function validateInstructorNpubs(values: Array<string | null | undefined>): string[] {
  const normalized = normaliseInstructorNpubs(values);
  for (const npub of normalized) {
    if (!/^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(npub)) {
      throw new Error(`Invalid instructor npub: ${npub}`);
    }
  }
  return normalized;
}
