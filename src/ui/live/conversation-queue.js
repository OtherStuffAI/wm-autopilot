function normalizeTime(value) {
  const parsed = Date.parse(typeof value === "string" ? value : "");
  return Number.isFinite(parsed) ? parsed : null;
}

function isReleasedQueuedPrompt(message, prompt) {
  const role = String(message?.role ?? message?.type ?? "").toLowerCase();
  if (role !== "user" || String(message?.content ?? "") !== String(prompt?.content ?? "")) return false;
  const messageTime = normalizeTime(message?.createdAt);
  const promptTime = normalizeTime(prompt?.timestamp);
  return messageTime !== null && promptTime !== null && messageTime >= promptTime;
}

export function mergeConversationWithQueuedPrompts(messages, prompts) {
  const canonicalMessages = Array.isArray(messages) ? messages : [];
  const queuedPrompts = [...(Array.isArray(prompts) ? prompts : [])]
    .sort((left, right) => Number(left?.order ?? 0) - Number(right?.order ?? 0));
  const releasedPromptIds = new Set();

  for (const message of canonicalMessages) {
    const released = queuedPrompts.find((prompt) => (
      !releasedPromptIds.has(prompt.id) && isReleasedQueuedPrompt(message, prompt)
    ));
    if (released?.id) releasedPromptIds.add(released.id);
  }

  const visibleQueuedPrompts = queuedPrompts
    .filter((prompt) => prompt?.id && !releasedPromptIds.has(prompt.id))
    .map((prompt) => ({
      id: `queued:${prompt.id}`,
      messageId: `queued:${prompt.id}`,
      sessionId: prompt.sessionId,
      role: "user",
      content: String(prompt.content ?? ""),
      createdAt: prompt.timestamp,
      queued: true,
      queueOrder: prompt.order,
    }));

  return [...canonicalMessages, ...visibleQueuedPrompts];
}
