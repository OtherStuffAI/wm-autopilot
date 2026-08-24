import { isAbsolute, normalize, resolve as resolvePath, sep } from "node:path";

export const secureResolvePath = (base: string, target: string): string => {
  if (!isAbsolute(base)) {
    throw new Error("Base path must be absolute");
  }

  const normalizedBase = normalize(base);
  const resolvedTarget = resolvePath(normalizedBase, target);
  const normalizedTarget = normalize(resolvedTarget);

  if (!normalizedTarget.startsWith(normalizedBase + sep) && normalizedTarget !== normalizedBase) {
    throw new Error(`Path traversal detected: ${target} escapes allowed directory`);
  }

  return normalizedTarget;
};

export const validatePathSegment = (segment: string): boolean => {
  const dangerousPatterns = [
    /\.\./,
    /[<>:"|?*]/,
    /^[.]/,
    /[.]+$/,
    /\x00/,
  ];

  return !dangerousPatterns.some(pattern => pattern.test(segment));
};

export const sanitizePath = (path: string): string => {
  const wasAbsolute = isAbsolute(path);
  const sanitized = path
    .split(sep)
    .filter(segment => segment.length > 0 && validatePathSegment(segment))
    .join(sep);
  return wasAbsolute ? sep + sanitized : sanitized;
};
