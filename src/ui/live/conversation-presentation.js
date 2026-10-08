function roleOf(message) {
  return String(message?.role ?? message?.type ?? "").toLowerCase();
}

function identityOf(message, index) {
  // Dexie keeps this row through optimistic prompt reconciliation, even when
  // the temporary transport identity is replaced by the server's user echo.
  if (typeof message?.id === "number") return `local:${message.id}`;
  return message?.messageId ?? message?.message_id ?? message?.id
    ?? message?.createdAt ?? message?.created_at ?? `position:${index}`;
}

function createGroup(role, anchor, members) {
  const id = `display-group:${anchor}:${role}`;
  let updatedAt;
  for (const message of members) {
    const timestamp = message.updatedAt ?? message.updated_at ?? message.createdAt ?? message.created_at;
    if (timestamp && (!updatedAt || Date.parse(timestamp) > Date.parse(updatedAt))) updatedAt = timestamp;
  }
  return {
    id,
    messageId: id,
    displayGroup: true,
    role,
    members,
    content: members.map((message) => String(message.content ?? message.message ?? "")).join("\n\n"),
    createdAt: members[0].createdAt ?? members[0].created_at,
    updatedAt,
    // Use content hashing in the HTML cache: any member can change, including
    // same-length edits with unchanged timestamps in historical snapshots.
  };
}

/** Presentation only. Never write these groups back to the transcript store. */
export function deriveConversationPresentation(conversation) {
  const messages = Array.isArray(conversation) ? conversation : [];
  const result = [];
  let anchor = null;
  let segment = [];
  function flush() {
    const tools = [];
    const thinking = [];
    const other = [];
    for (const message of segment) {
      const role = roleOf(message);
      const members = role === "agent-tools" ? tools
        : role === "agent-thinking" || role === "agent-working" ? thinking : null;
      if (!members) other.push(message);
      else if (String(message.content ?? message.message ?? "").trim()) members.push(message);
    }
    if (tools.length) result.push(createGroup("agent-tools", anchor, tools));
    if (thinking.length) result.push(createGroup("agent-thinking", anchor, thinking));
    result.push(...other);
    segment = [];
  }
  messages.forEach((message, index) => {
    if (roleOf(message) === "user") {
      flush();
      anchor = `prompt:${identityOf(message, index)}`;
      result.push(message);
    } else {
      // A retained transcript without a user echo still has a deterministic
      // anchor. Subsequent prompt boundaries always start a fresh group.
      if (anchor === null) anchor = `history:${identityOf(message, index)}`;
      segment.push(message);
    }
  });
  flush();
  return result;
}

/** Extend a display window back to its prompt; never cut through a turn. */
export function getTurnWindowStart(messages, visibleCount) {
  if (visibleCount <= 0) return 0;
  let start = Math.max(0, messages.length - Math.max(1, visibleCount));
  while (start > 0 && roleOf(messages[start]) !== "user") start -= 1;
  return start;
}
