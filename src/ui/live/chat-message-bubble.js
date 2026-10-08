import { attachCopyButton } from "../utils/clipboard.js";
import {
  getChatMessageHtmlCacheOptions,
  renderChatMessageHtml,
  renderWorkingNotesHtml,
} from "../rendering/chat-message-content.js";
import { attachMessageSpeechButton } from "./message-speech.js";
import { getWorkingNotesPanelKey, isWorkingNotesPanelOpen } from "./working-notes-toggle.js";
import { shouldDefaultWorkingNotesOpen } from "./working-notes-display.js";
import { attachMessageTimestamp } from "./message-timestamp.js";

import { shouldFormatAgentMessage, isWorkingNotesMessage, isErrorMessage, getWorkingNotesLabel } from "./chat-message-roles.js";
function getSpeechSummary(message) {
  const summary = typeof message?.speech?.summary === "string" ? message.speech.summary.trim() : "";
  return summary;
}

function createSpeechSummaryElement(summary) {
  const element = document.createElement("p");
  element.className = "wm-message-speech-summary";
  element.dataset.testid = "message-speech-summary";
  element.textContent = summary;
  return element;
}

export function createMessageBubble(message, options = {}) {
  const role = String(message?.role ?? message?.type ?? "assistant").toLowerCase();
  const bubble = document.createElement("article");
  const styleRole = isWorkingNotesMessage(message) || role.startsWith("agent-") ? "assistant" : role;
  bubble.className = `wm-message ${styleRole}`;
  bubble.dataset.role = role;
  if (isErrorMessage(message)) {
    bubble.setAttribute("role", "alert");
    bubble.setAttribute("aria-live", "assertive");
    bubble.dataset.testid = "agent-error-message";
  }
  const body = document.createElement("div");
  body.className = "wm-message-body";
  const workingNotesKey = isWorkingNotesMessage(message)
    ? getWorkingNotesPanelKey(options.sessionId, message)
    : null;
  const workingNotesLabel = isWorkingNotesMessage(message) ? getWorkingNotesLabel(message) : null;
  const cacheOptions = getChatMessageHtmlCacheOptions(message, { sessionId: options.sessionId });
  body.innerHTML = isWorkingNotesMessage(message)
    ? renderWorkingNotesHtml(message.content ?? message.message ?? "", {
        cleanAgentText: Boolean(options.agentOutputFormattingEnabled),
        workingNotesKey,
        workingNotesMembers: message.members,
        workingNotesOpen: isWorkingNotesPanelOpen(
          workingNotesKey,
          shouldDefaultWorkingNotesOpen(message, options.isFirstMessage),
        ),
        workingNotesLabel,
        config: options.config,
        ...cacheOptions,
      })
    : renderChatMessageHtml(message.content ?? message.message ?? "", {
        cleanAgentText: Boolean(options.agentOutputFormattingEnabled && shouldFormatAgentMessage(message)),
        config: options.config,
        ...cacheOptions,
      });
  bubble.append(body);
  const speechSummary = getSpeechSummary(message);
  if (speechSummary) {
    bubble.append(createSpeechSummaryElement(speechSummary));
  }
  attachCopyButton(bubble);
  attachMessageSpeechButton(bubble, {
    sessionId: options.sessionId,
    message,
    showToast: options.showToast,
  });
  attachMessageTimestamp(bubble, message);
  return bubble;
}
