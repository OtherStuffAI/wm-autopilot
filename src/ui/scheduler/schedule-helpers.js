/** Pure schedule helpers shared by the trigger form and list. */

/** Build a cron expression from the friendly schedule fields. */
export function buildCron(frequency, hour, minute, weekday) {
  const mm = String(minute);
  const hh = String(hour);
  switch (frequency) {
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
  if (parts.length !== 5) return expr;
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

/** Parse a cron expression back into friendly schedule picker fields. */
export function parseCron(expr) {
  if (!expr) return { frequency: "daily", hour: 9, minute: 0, weekday: "1" };
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return { frequency: "daily", hour: 9, minute: 0, weekday: "1" };
  const [mm, hh, , , dow] = parts;

  // Fixed-interval patterns
  if (expr === "* * * * *") return { frequency: "every_minute", hour: 9, minute: 0, weekday: "1" };
  if (expr === "*/5 * * * *") return { frequency: "every_5min", hour: 9, minute: 0, weekday: "1" };
  if (expr === "*/15 * * * *") return { frequency: "every_15min", hour: 9, minute: 0, weekday: "1" };
  if (expr === "*/30 * * * *") return { frequency: "every_30min", hour: 9, minute: 0, weekday: "1" };

  const minute = parseInt(mm, 10) || 0;
  const hour = parseInt(hh, 10) || 9;

  if (hh === "*") return { frequency: "hourly", hour: 9, minute, weekday: "1" };
  if (hh === "*/2") return { frequency: "every_2h", hour: 9, minute, weekday: "1" };
  if (hh === "*/3") return { frequency: "every_3h", hour: 9, minute, weekday: "1" };
  if (hh === "*/4") return { frequency: "every_4h", hour: 9, minute, weekday: "1" };
  if (hh === "*/6") return { frequency: "every_6h", hour: 9, minute, weekday: "1" };
  if (hh.startsWith("*/")) return { frequency: "every_6h", hour: 9, minute, weekday: "1" };
  if (dow === "1-5") return { frequency: "weekdays", hour, minute, weekday: "1" };
  if (dow !== "*") return { frequency: "weekly", hour, minute, weekday: dow };
  return { frequency: "daily", hour, minute, weekday: "1" };
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
