/**
 * Check whether the current time (in the given timezone) falls within an
 * active time window defined by HH:MM start/end strings.
 * Handles overnight windows where start > end (e.g. 22:00–05:00).
 * Returns true if no window is configured (both null).
 */
export function isWithinActiveWindow(
  startTime: string | null,
  endTime: string | null,
  timezone: string,
): boolean {
  if (!startTime || !endTime) return true;

  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone || "UTC",
  });
  const nowStr = formatter.format(now); // "HH:MM"
  const [nowH = 0, nowM = 0] = nowStr.split(":").map(Number);
  const nowMinutes = nowH * 60 + nowM;

  const [startH = 0, startM = 0] = startTime.split(":").map(Number);
  const startMinutes = startH * 60 + startM;

  const [endH = 0, endM = 0] = endTime.split(":").map(Number);
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    // Same-day window: e.g. 09:00–17:00
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  // Overnight window: e.g. 22:00–05:00
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

/** Convert a simple glob pattern (e.g. "*.json") into a RegExp. */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

