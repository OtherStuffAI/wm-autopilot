/** Pure schedule helpers shared by the trigger form and list. */

/** Build a cron expression from the friendly schedule fields. */
export function buildCron(frequency, hour, minute, weekday, customCron = "") {
  const mm = String(minute);
  const hh = String(hour);
  switch (frequency) {
    case "custom":        return customCron;
    case "every_minute":  return "* * * * *";
    case "every_5min":    return "*/5 * * * *";
    case "every_15min":   return "*/15 * * * *";
    case "every_30min":   return "*/30 * * * *";
    case "hourly":        return `${mm} * * * *`;
    case "every_2h":      return `${mm} */2 * * *`;
    case "every_3h":      return `${mm} */3 * * *`;
    case "every_4h":      return `${mm} */4 * * *`;
    case "every_6h":      return `${mm} */6 * * *`;
    case "daily":         return `${mm} ${hh} * * *`;
    case "weekdays":      return `${mm} ${hh} * * 1-5`;
    case "weekly":        return `${mm} ${hh} * * ${weekday}`;
    default:              return `${mm} ${hh} * * *`;
  }
}

/** Describe a cron expression in plain English. */
export function describeCron(expr) {
  if (!expr) return "";
  const map = {
    "* * * * *": "Every minute",
    "*/5 * * * *": "Every 5 minutes",
    "*/15 * * * *": "Every 15 minutes",
    "*/30 * * * *": "Every 30 minutes",
  };
  if (map[expr]) return map[expr];
  const parts = expr.trim().split(/\s+/);
  const candidate = parts.length === 5 ? friendlyCandidate(parts.join(" ")) : null;
  if (!candidate || buildCron(candidate.frequency, candidate.hour, candidate.minute, candidate.weekday) !== parts.join(" ")) {
    return `Custom schedule: ${expr.trim()}`;
  }
  const [mm, hh, , , dow] = parts;
  const time = `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`;
  if (parts[1] === "*") return `Hourly at :${mm.padStart(2, "0")}`;
  if (parts[1].startsWith("*/")) return `Every ${parts[1].slice(2)}h at :${mm.padStart(2, "0")}`;
  const days = { "0": "Sunday", "1": "Monday", "2": "Tuesday", "3": "Wednesday", "4": "Thursday", "5": "Friday", "6": "Saturday" };
  if (dow === "1-5") return `Weekdays at ${time}`;
  if (dow !== "*" && days[dow]) return `${days[dow]}s at ${time}`;
  if (dow === "*") return `Daily at ${time}`;
  return expr;
}

/** Check whether frequency needs a time picker. */
export function frequencyNeedsTime(freq) {
  return ["hourly", "every_2h", "every_3h", "every_4h", "every_6h", "daily", "weekdays", "weekly"].includes(freq);
}

/** Check whether frequency needs hour picker (not just minute). */
export function frequencyNeedsHour(freq) {
  return ["daily", "weekdays", "weekly"].includes(freq);
}

/** Frequency used when a saved expression has no exact friendly equivalent. */
export const CUSTOM_FREQUENCY = "custom";

const FIXED_FREQUENCIES = {
  "* * * * *": "every_minute",
  "*/5 * * * *": "every_5min",
  "*/15 * * * *": "every_15min",
  "*/30 * * * *": "every_30min",
};
const HOUR_STEP_FREQUENCIES = { "*": "hourly", "*/2": "every_2h", "*/3": "every_3h", "*/4": "every_4h", "*/6": "every_6h" };
const PLAIN_NUMBER = /^\d{1,2}$/;

function friendlyCandidate(expr) {
  const parts = expr.split(" ");
  if (parts.length !== 5) return null;
  const [mm, hh, dom, mon, dow] = parts;
  if (FIXED_FREQUENCIES[expr]) return { frequency: FIXED_FREQUENCIES[expr], hour: 9, minute: 0, weekday: "1" };
  if (dom !== "*" || mon !== "*" || !PLAIN_NUMBER.test(mm)) return null;
  const minute = Number(mm);
  if (HOUR_STEP_FREQUENCIES[hh] && dow === "*") return { frequency: HOUR_STEP_FREQUENCIES[hh], hour: 9, minute, weekday: "1" };
  if (!PLAIN_NUMBER.test(hh)) return null;
  const hour = Number(hh);
  if (dow === "*") return { frequency: "daily", hour, minute, weekday: "1" };
  if (dow === "1-5") return { frequency: "weekdays", hour, minute, weekday: "1" };
  if (/^[0-6]$/.test(dow)) return { frequency: "weekly", hour, minute, weekday: dow };
  return null;
}

/**
 * Parse a cron expression into friendly picker fields. Only expressions the
 * picker reproduces exactly (and whose minute is a selectable 5-minute step)
 * map to a friendly frequency; anything else becomes `custom` and keeps the
 * original text, so opening and saving an edit never rewrites the schedule.
 */
export function parseCron(expr) {
  const text = typeof expr === "string" ? expr.trim().replace(/\s+/g, " ") : "";
  if (!text) return { ...DEFAULT_SCHEDULE };
  const candidate = friendlyCandidate(text);
  const exact = candidate
    && candidate.minute % 5 === 0 && candidate.minute < 60 && candidate.hour < 24
    && buildCron(candidate.frequency, candidate.hour, candidate.minute, candidate.weekday) === text;
  if (exact) return candidate;
  return { frequency: CUSTOM_FREQUENCY, hour: 9, minute: 0, weekday: "1", customCron: expr.trim() };
}

export const DEFAULT_SCHEDULE = Object.freeze({ frequency: "daily", hour: 9, minute: 0, weekday: "1" });

export const FREQUENCY_OPTIONS = Object.freeze([
  ["every_minute", "Every minute"],
  ["every_5min", "Every 5 minutes"],
  ["every_15min", "Every 15 minutes"],
  ["every_30min", "Every 30 minutes"],
  ["hourly", "Hourly"],
  ["every_2h", "Every 2 hours"],
  ["every_3h", "Every 3 hours"],
  ["every_4h", "Every 4 hours"],
  ["every_6h", "Every 6 hours"],
  ["daily", "Daily"],
  ["weekdays", "Weekdays (Mon–Fri)"],
  ["weekly", "Weekly"],
]);

/** Shown only while a saved schedule has no friendly equivalent. */
export const CUSTOM_FREQUENCY_LABEL = "Custom (keep current expression)";

export const WEEKDAY_OPTIONS = Object.freeze([
  ["1", "Monday"], ["2", "Tuesday"], ["3", "Wednesday"], ["4", "Thursday"],
  ["5", "Friday"], ["6", "Saturday"], ["0", "Sunday"],
]);

/** True when the timezone is an IANA name the runtime can resolve. */
export function isValidTimezone(timezone) {
  const value = String(timezone || "").trim();
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** "Daily at 09:00 (Europe/London)" — the schedule with its timezone attached. */
export function describeSchedule(cronExpression, timezone) {
  const text = describeCron(cronExpression);
  if (!text) return "";
  return timezone ? `${text} (${timezone})` : text;
}

/** The zone this browser shows run timestamps in (IANA name). */
export function displayTimezone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidTimezone(zone) ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

/** "30 Oct, 14:05 AWST" — a run timestamp with its display zone abbreviation. */
export function formatTimestamp(iso, timezone) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const timeZone = timezone && isValidTimezone(timezone) ? timezone : undefined;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  });
}
