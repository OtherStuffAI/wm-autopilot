import { createMessageBubble } from "./chat-message-bubble.js";
import { deriveConversationPresentation } from "./conversation-presentation.js";

export function createArchivedConversation(options) {
  const wrapper = document.createElement("div");
  wrapper.className = "wm-conversation wm-conversation-archived";
  const messages = deriveConversationPresentation(options.conversation);
  if (!messages.length) {
    const empty = document.createElement("p");
    empty.textContent = "This session has no messages.";
    wrapper.append(empty);
  }
  messages.forEach((message, index) => {
    wrapper.append(createMessageBubble(message, { ...options, isFirstMessage: index === 0 }));
  });
  return wrapper;
}
