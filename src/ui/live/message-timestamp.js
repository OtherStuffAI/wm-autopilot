const MESSAGE_TIMESTAMP_ROLES = new Set(["user", "assistant", "agent"]);

function getMessageRole(message) {
  return String(message?.role ?? message?.type ?? "").toLowerCase();
}

export function formatMessageTimestamp(message, options = {}) {
  if (!MESSAGE_TIMESTAMP_ROLES.has(getMessageRole(message))) return "";

  const value = message?.createdAt ?? message?.created_at;
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

export function attachMessageTimestamp(bubble, message) {
  const timestamp = formatMessageTimestamp(message);
  if (!timestamp || !bubble) return;

  const actions = bubble.querySelector(".wm-message-actions") ?? document.createElement("div");
  actions.className = "wm-message-actions";

  const time = document.createElement("time");
  time.className = "wm-message-timestamp";
  time.dataset.testid = "message-timestamp";
  time.dateTime = String(message.createdAt ?? message.created_at);
  time.setAttribute("aria-label", `Sent ${timestamp}`);
  time.textContent = timestamp;
  const copyButton = actions.querySelector(".wm-message-copy");
  if (copyButton) {
    actions.insertBefore(time, copyButton);
  } else {
    actions.append(time);
  }

  if (!actions.parentElement) {
    bubble.append(actions);
  }
}
