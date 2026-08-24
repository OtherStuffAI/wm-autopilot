const TRUE_VALUES = new Set(["true", "1"]);
const FALSE_VALUES = new Set(["false", "0"]);

const normaliseFlag = (value: string | undefined): string | null => {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
};

const isHttpsRequest = (request: Request): boolean => {
  const forwardedProto = normaliseFlag(request.headers.get("x-forwarded-proto") ?? undefined);
  if (forwardedProto) {
    return forwardedProto.split(",").some((value) => value.trim() === "https");
  }

  return new URL(request.url).protocol === "https:";
};

export const shouldUseSecureCookies = (request: Request): boolean => {
  const configuredFlag = normaliseFlag(Bun.env.IDENTITY_COOKIE_SECURE ?? Bun.env.COOKIE_SECURE);
  if (configuredFlag && TRUE_VALUES.has(configuredFlag)) {
    return true;
  }
  if (configuredFlag && FALSE_VALUES.has(configuredFlag)) {
    return false;
  }
  return isHttpsRequest(request);
};
