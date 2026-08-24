export function openOriginFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function normalizeRegisteredOpenOrigins(
  values: readonly unknown[] | null | undefined,
  fallbackLaunchUrl?: string | null,
): string[] {
  const supplied = values ?? [];
  const origins = supplied.map((value) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("registeredOpenOrigins must contain HTTPS origins");
    }
    const origin = openOriginFromUrl(value.trim());
    if (!origin || origin !== value.trim().replace(/\/$/, "")) {
      throw new Error("registeredOpenOrigins must contain normalized HTTPS origins");
    }
    return origin;
  });
  if (origins.length === 0 && fallbackLaunchUrl) {
    const fallback = openOriginFromUrl(fallbackLaunchUrl);
    if (fallback) origins.push(fallback);
  }
  return Array.from(new Set(origins)).sort();
}

export function registeredOpenOriginsInput(body: Record<string, unknown>): unknown[] | undefined {
  const value = body.registeredOpenOrigins ?? body.registered_open_origins;
  return value === undefined ? undefined : Array.isArray(value) ? value : [value];
}
