const DEFAULT_SEGMENT = "anonymous";

const sanitizeSegment = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return DEFAULT_SEGMENT;
  const cleaned = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) return DEFAULT_SEGMENT;
  return cleaned.slice(0, 120);
};

export const normaliseNpub = (input: string | null | undefined): string | null => {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const normaliseNpubList = (
  input: string | string[] | null | undefined,
): string[] => {
  const values = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : [];
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const npub = normaliseNpub(value);
    if (!npub || seen.has(npub)) {
      continue;
    }
    seen.add(npub);
    normalized.push(npub);
  }

  return normalized;
};

export const getConfiguredAdminNpubs = (
  env: Record<string, string | undefined> = Bun.env,
): string[] => {
  const configured = env.ADMIN_NPUBS?.trim()
    ? env.ADMIN_NPUBS
    : env.ADMIN_NPUB?.trim()
      ? env.ADMIN_NPUB
      : env.WINGMAN_ADMIN_NPUB;
  return normaliseNpubList(configured);
};

export const isNpubInList = (
  npub: string | null | undefined,
  npubs: Iterable<string>,
): boolean => {
  const normalized = normaliseNpub(npub);
  if (!normalized) return false;
  for (const candidate of npubs) {
    if (normalized === normaliseNpub(candidate)) {
      return true;
    }
  }
  return false;
};

export const deriveNpubSegment = (input: string | null | undefined): string => {
  const normalized = normaliseNpub(input);
  if (!normalized) return DEFAULT_SEGMENT;
  return sanitizeSegment(normalized);
};
