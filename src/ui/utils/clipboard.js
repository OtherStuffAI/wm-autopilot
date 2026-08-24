/**
 * Clipboard utilities for copying text and creating copy buttons.
 */

import { MessageStore } from "../live/index.js";
import { state } from "../state/index.js";

// SVG icons for copy button states
const COPY_ICON_DEFAULT_SVG =
  '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M16 1H8a2 2 0 0 0-2 2v2H5a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8l1-2H5V7h1v2h10V3h2v9l2-1V3a2 2 0 0 0-2-2Zm-2 6H8V3h6v4Zm7.71 9.29-5-5a1 1 0 0 0-1.42 1.42l1.3 1.29-4.59 4.59V22h3.41l4.59-4.59 1.29 1.3a1 1 0 0 0 1.42-1.42Z"/></svg>';

const COPY_ICON_SUCCESS_SVG =
  '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="m9 16.17-3.5-3.5L4.08 14.1 9 19l12-12-1.41-1.41Z"/></svg>';

// Simple copy icon (used for message bubbles)
const MESSAGE_COPY_ICON_SVG =
  '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M15 3H7a2 2 0 0 0-2 2v10h2V5h8V3zm4 4h-8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zm0 12h-8V9h8v10z"/></svg>';

/**
 * Copies text to the clipboard using the Clipboard API with fallback.
 * @param {string} text - The text to copy
 * @returns {Promise<boolean>} True if copy succeeded
 */
export async function copyTextToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "absolute";
    fallback.style.left = "-9999px";
    document.body.append(fallback);
    fallback.select();
    const success = document.execCommand("copy");
    fallback.remove();
    return success;
  } catch (error) {
    console.error("Failed to copy to clipboard", error);
    return false;
  }
}

function getCopyableText(node) {
  if (!node) return "";
  const clone = node.cloneNode(true);
  clone.querySelectorAll?.("[data-copy-exclude]").forEach((item) => item.remove());
  return clone.textContent ?? "";
}

/**
 * Attaches a copy button to a message bubble element.
 * @param {HTMLElement} bubble - The message bubble element
 */
export function attachCopyButton(bubble) {
  if (!bubble || bubble.dataset.copyAttached === "true") return;
  const actions = bubble.querySelector(".wm-message-actions") ?? document.createElement("div");
  actions.className = "wm-message-actions";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "wm-message-copy";
  button.setAttribute("aria-label", "Copy message");
  button.dataset.testid = "message-copy";
  button.innerHTML = MESSAGE_COPY_ICON_SVG;
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const body = bubble.querySelector(".wm-message-body") ?? bubble.querySelector("pre");
    const text = getCopyableText(body);
    const copied = await copyTextToClipboard(text);
    if (copied) {
      bubble.dataset.copied = "true";
      setTimeout(() => {
        if (bubble.isConnected) {
          delete bubble.dataset.copied;
        }
      }, 1600);
    }
  });
  actions.append(button);
  if (!actions.parentNode) {
    bubble.append(actions);
  }
  bubble.dataset.copyAttached = "true";
}

let markdownCodeCopyAttached = false;

export function attachMarkdownCodeBlockCopyHandler(root = document) {
  if (markdownCodeCopyAttached || !root?.addEventListener) return;
  root.addEventListener("click", async (event) => {
    const button = event.target?.closest?.("[data-code-block-copy]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const block = button.closest(".wm-markdown-code-block");
    const code = block?.querySelector("pre code");
    const text = code?.textContent ?? "";
    const copied = await copyTextToClipboard(text);
    if (!copied) {
      button.dataset.state = "error";
      setTimeout(() => {
        if (button.isConnected) {
          delete button.dataset.state;
        }
      }, 1600);
      return;
    }
    button.dataset.state = "success";
    button.setAttribute("aria-label", "Code block copied");
    button.title = "Copied";
    setTimeout(() => {
      if (button.isConnected) {
        delete button.dataset.state;
        button.setAttribute("aria-label", "Copy code block");
        button.title = "Copy code block";
      }
    }, 1600);
  });
  markdownCodeCopyAttached = true;
}

/**
 * Copies all messages from a conversation to the clipboard.
 * @param {string} sessionId - The session ID
 * @returns {Promise<boolean>} True if copy succeeded
 */
export async function copyConversationToClipboard(sessionId) {
  const conversation = await MessageStore.getSessionMessages(sessionId);
  let textBlocks = conversation;
  if (textBlocks.length === 0) {
    const container = state.conversationContainers.get(sessionId);
    if (container) {
      const domMessages = container.querySelectorAll(".wm-message-body, .wm-message > pre");
      textBlocks = Array.from(domMessages).map((node) => ({
        role: null,
        content: getCopyableText(node),
      }));
    }
  }

  if (textBlocks.length === 0) return false;

  const formatted = textBlocks
    .map((message) => {
      const role = typeof message.role === "string" ? message.role : message.type;
      const labelSource = role ?? "assistant";
      const label = `${labelSource.charAt(0).toUpperCase()}${labelSource.slice(1)}`;
      const content = message.content ?? message.message ?? "";
      if (!content) return label;
      return `${label}:\n${content}`;
    })
    .join("\n\n")
    .trim();

  if (!formatted) return false;
  return copyTextToClipboard(formatted);
}

/**
 * Creates a small icon button that copies text when clicked.
 * @param {Object} options - Button configuration
 * @param {string} options.text - Text to copy when clicked
 * @param {string} [options.ariaLabel] - Accessibility label
 * @param {string} [options.title] - Tooltip text
 * @returns {HTMLButtonElement} The created button element
 */
export function createCopyIconButton({ text, ariaLabel, title }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "wm-icon-button";
  if (ariaLabel) {
    button.setAttribute("aria-label", ariaLabel);
  }
  if (title) {
    button.title = title;
  }
  button.innerHTML = COPY_ICON_DEFAULT_SVG;
  button.addEventListener("click", async () => {
    const success = await copyTextToClipboard(text);
    if (success) {
      button.dataset.state = "success";
      button.innerHTML = COPY_ICON_SUCCESS_SVG;
      setTimeout(() => {
        if (button.isConnected) {
          delete button.dataset.state;
          button.innerHTML = COPY_ICON_DEFAULT_SVG;
        }
      }, 1600);
      return;
    }
    button.dataset.state = "error";
    setTimeout(() => {
      if (button.isConnected) {
        delete button.dataset.state;
      }
    }, 1600);
  });
  return button;
}
