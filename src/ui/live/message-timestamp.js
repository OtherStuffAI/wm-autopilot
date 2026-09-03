const CONVERSATION_TIMESTAMP_ROLES = new Set(["user", "assistant", "agent"]);
const WORKING_TIMESTAMP_ROLES = new Set(["agent-working", "agent-thinking", "agent-tools"]);

function getMessageRole(message) {
  return String(message?.role ?? message?.type ?? "").toLowerCase();
}

export function isWorkingMessageTimestamp(message) {
  return WORKING_TIMESTAMP_ROLES.has(getMessageRole(message));
}

export function getMessageTimestampDateTime(message) {
  if (isWorkingMessageTimestamp(message)) {
    return message?.updatedAt ?? message?.updated_at ?? message?.createdAt ?? message?.created_at;
  }
  return message?.createdAt ?? message?.created_at;
}

export function formatMessageTimestamp(message, options = {}) {
  const role = getMessageRole(message);
  if (!CONVERSATION_TIMESTAMP_ROLES.has(role) && !WORKING_TIMESTAMP_ROLES.has(role)) return "";

  const value = getMessageTimestampDateTime(message);
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "";

  const locale = options.locale;
  const timeZone = options.timeZone;
  const dateText = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
  const timeText = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);

  return `${dateText} - ${timeText}`;
}

export function formatMessageTimestampLabel(message, options = {}) {
  const timestamp = formatMessageTimestamp(message, options);
  if (!timestamp) return "";
  return isWorkingMessageTimestamp(message) ? `last update : ${timestamp}` : timestamp;
}

export function getMessageTimestampAriaLabel(message, options = {}) {
  const timestamp = formatMessageTimestamp(message, options);
  if (!timestamp) return "";
  return isWorkingMessageTimestamp(message) ? `Last updated ${timestamp}` : `Sent ${timestamp}`;
}

export function attachMessageTimestamp(bubble, message) {
  const label = formatMessageTimestampLabel(message);
  if (!label || !bubble) return;

  const actions = bubble.querySelector(".wm-message-actions") ?? document.createElement("div");
  actions.className = "wm-message-actions";

  const time = document.createElement("time");
  time.className = "wm-message-timestamp";
  if (isWorkingMessageTimestamp(message)) {
    time.classList.add("wm-message-timestamp--working");
  }
  time.dataset.testid = "message-timestamp";
  time.dateTime = String(getMessageTimestampDateTime(message));
  time.setAttribute("aria-label", getMessageTimestampAriaLabel(message));
  time.textContent = label;
  actions.prepend(time);

  if (!actions.parentElement) {
    bubble.append(actions);
  }
}
