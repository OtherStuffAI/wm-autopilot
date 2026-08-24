/**
 * Private chat view — list, conversation, composer, and CRUD operations.
 *
 * Depends on: state, chat API helpers, render, showToast (via DI).
 */

import { renderChatMessageHtml } from "../rendering/chat-message-content.js";
import { openConfirmDialog } from "../common/dialog-prompts.js";
import {
  CHAT_ROUTE_PREFIX,
  getChatIdFromPath,
  buildChatUrl,
  createChatDialogController,
  fetchChatsApi,
  fetchChatMessagesApi,
  postChatMessageApi,
  deleteChatApi,
  streamChatResponse,
} from "./index.js";

export function initPrivateChat(deps) {
  const { state, getCurrentRoute, setCurrentRoute, render, showToast } = deps;

  let chatDialogController = null;

  // ── Data loading ────────────────────────────────────────────────

  const loadChats = async () => {
    if (state.chats.loading) return;
    state.chats.loading = true;

    try {
      const result = await fetchChatsApi();
      if (result?.unauthorized) {
        state.chats.error = "Authentication required";
        state.chats.items = [];
      } else if (result?.chats) {
        state.chats.items = result.chats.sort((a, b) => {
          const dateA = a.startedAt ? new Date(a.startedAt).getTime() : 0;
          const dateB = b.startedAt ? new Date(b.startedAt).getTime() : 0;
          return dateB - dateA;
        });
        state.chats.error = null;
      }
      state.chats.initialized = true;
    } catch (err) {
      console.error("[chat] Failed to load chats:", err);
      state.chats.error = err.message || "Failed to load chats";
    } finally {
      state.chats.loading = false;
      if (getCurrentRoute() === "chat") {
        render();
      }
    }
  };

  const loadChatMessages = async (chatId) => {
    if (!chatId) return;

    try {
      const result = await fetchChatMessagesApi(chatId);
      if (result?.messages) {
        state.chatConversations.set(chatId, result.messages);
      }
    } catch (err) {
      console.error("[chat] Failed to load messages:", err);
    }
  };

  // ── Navigation ──────────────────────────────────────────────────

  const navigateToChat = (chatId) => {
    const url = chatId ? buildChatUrl(chatId) : CHAT_ROUTE_PREFIX;
    state.activeChatId = chatId || null;
    setCurrentRoute("chat");
    window.history.pushState({ route: "chat", chatId }, "", url);
    render();
  };

  // ── Dialog ──────────────────────────────────────────────────────

  const openPrivateChatDialog = () => {
    if (!chatDialogController) {
      chatDialogController = createChatDialogController({
        onCreated: (chat) => {
          state.chats.items.unshift(chat);
          navigateToChat(chat.id);
        },
        showToast,
      });
    }
    chatDialogController.open();
  };

  // ── Delete ──────────────────────────────────────────────────────

  const deleteChat = async (chatId) => {
    const confirmed = await openConfirmDialog({
      title: "Delete Chat",
      description: "Delete this chat? This cannot be undone.",
      confirmLabel: "Delete",
      testId: "delete-chat-dialog",
    });
    if (!confirmed) {
      return;
    }

    const result = await deleteChatApi(chatId);
    if (result.success) {
      state.chats.items = state.chats.items.filter((c) => c.id !== chatId);
      state.chatConversations.delete(chatId);
      state.chatMessageDrafts.delete(chatId);
      state.chatStreaming.delete(chatId);

      if (state.activeChatId === chatId) {
        navigateToChat(null);
      } else {
        render();
      }
      showToast("Chat deleted");
    } else {
      showToast(result.error || "Failed to delete chat", "error");
    }
  };

  // ── Send message ────────────────────────────────────────────────

  const sendChatMessageToApi = async (chatId, content) => {
    if (!chatId || !content.trim()) return;

    const userMessage = {
      id: `temp-${Date.now()}`,
      role: "user",
      content: content.trim(),
      createdAt: new Date().toISOString(),
    };

    const existing = state.chatConversations.get(chatId) || [];
    state.chatConversations.set(chatId, [...existing, userMessage]);

    state.chatMessageDrafts.set(chatId, "");
    state.chatStreaming.set(chatId, { active: true, content: "" });
    render();

    try {
      const response = await postChatMessageApi(chatId, content.trim());

      let fullContent = "";
      for await (const event of streamChatResponse(response)) {
        if (event.type === "chunk" && event.content) {
          fullContent += event.content;
          state.chatStreaming.set(chatId, { active: true, content: fullContent });
          render();
        } else if (event.type === "done") {
          const messages = state.chatConversations.get(chatId) || [];
          const assistantMessage = {
            id: event.messageId || `msg-${Date.now()}`,
            role: "assistant",
            content: fullContent,
            createdAt: new Date().toISOString(),
          };
          state.chatConversations.set(chatId, [...messages, assistantMessage]);
          state.chatStreaming.set(chatId, { active: false, content: "" });
          render();
          break;
        } else if (event.type === "error") {
          showToast(event.content || "Chat error", "error");
          state.chatStreaming.set(chatId, { active: false, content: "" });
          render();
          break;
        }
      }
    } catch (err) {
      console.error("[chat] Message error:", err);
      showToast(err.message || "Failed to send message", "error");
      state.chatStreaming.set(chatId, { active: false, content: "" });
      render();
    }
  };

  // ── Renderers ───────────────────────────────────────────────────

  const renderChatMessage = (message, isStreaming = false) => {
    const container = document.createElement("div");
    container.className = `wm-chat-message wm-chat-message-${message.role}`;
    if (isStreaming) {
      container.classList.add("wm-chat-message-streaming");
    }

    const roleLabel = document.createElement("div");
    roleLabel.className = "wm-chat-message-role";
    roleLabel.textContent = message.role === "user" ? "You" : "Assistant";

    const contentEl = document.createElement("div");
    contentEl.className = "wm-chat-message-content";
    contentEl.innerHTML = renderChatMessageHtml(message.content, { config: state.config });

    container.append(roleLabel, contentEl);
    return container;
  };

  const renderChatConversation = (chatId) => {
    const container = document.createElement("div");
    container.className = "wm-chat-conversation";

    const messages = state.chatConversations.get(chatId) || [];
    const streaming = state.chatStreaming.get(chatId);

    if (messages.length === 0 && !streaming?.active) {
      const empty = document.createElement("p");
      empty.className = "wm-chat-empty";
      empty.textContent = "Start a conversation by typing a message below.";
      container.append(empty);
      return container;
    }

    for (const message of messages) {
      container.append(renderChatMessage(message));
    }

    if (streaming?.active && streaming.content) {
      const streamingMessage = {
        id: "streaming",
        role: "assistant",
        content: streaming.content,
        createdAt: new Date().toISOString(),
      };
      container.append(renderChatMessage(streamingMessage, true));
    }

    return container;
  };

  const renderChatComposer = (chatId) => {
    const composer = document.createElement("form");
    composer.className = "wm-composer";

    const textarea = document.createElement("textarea");
    textarea.placeholder = "Type your message...";
    textarea.setAttribute("rows", "1");
    textarea.dataset.focusKey = `chat-composer-${chatId}`;
    textarea.value = state.chatMessageDrafts.get(chatId) || "";

    const streaming = state.chatStreaming.get(chatId);
    const isStreaming = streaming?.active ?? false;
    textarea.disabled = isStreaming;

    const resizeTextarea = () => {
      textarea.style.height = "auto";
      const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight) || 20;
      const minHeight = lineHeight * 2.5;
      const maxHeight = lineHeight * 8;
      const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
      textarea.style.height = `${nextHeight}px`;
      textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
    };

    textarea.addEventListener("input", () => {
      state.chatMessageDrafts.set(chatId, textarea.value);
      resizeTextarea();
    });

    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (textarea.value.trim() && !isStreaming) {
          sendChatMessageToApi(chatId, textarea.value);
        }
      }
    });

    const buttonGroup = document.createElement("div");
    buttonGroup.className = "wm-button-group";

    const sendBtn = document.createElement("button");
    sendBtn.type = "submit";
    sendBtn.className = "wm-button";
    sendBtn.innerHTML = `<span class="button-text">${isStreaming ? "Sending..." : "Send"}</span>`;
    sendBtn.disabled = isStreaming;

    buttonGroup.append(sendBtn);

    composer.addEventListener("submit", (e) => {
      e.preventDefault();
      if (textarea.value.trim() && !isStreaming) {
        sendChatMessageToApi(chatId, textarea.value);
      }
    });

    composer.append(textarea, buttonGroup);

    requestAnimationFrame(resizeTextarea);

    return composer;
  };

  const renderChat = () => {
    const wrapper = document.createElement("div");
    wrapper.className = "wm-chat";

    const chatId = getChatIdFromPath(window.location.pathname);

    if (!state.chats.initialized && !state.chats.loading) {
      void loadChats();
    }

    if (!chatId) {
      const header = document.createElement("div");
      header.className = "wm-chat-header";

      const title = document.createElement("h2");
      title.textContent = "Private Chats";

      const newBtn = document.createElement("button");
      newBtn.className = "wm-button";
      newBtn.textContent = "New Chat";
      newBtn.addEventListener("click", openPrivateChatDialog);

      header.append(title, newBtn);
      wrapper.append(header);

      const listContainer = document.createElement("div");
      listContainer.className = "wm-chat-list";

      if (state.chats.loading && !state.chats.initialized) {
        const loading = document.createElement("p");
        loading.className = "wm-chat-status";
        loading.textContent = "Loading chats...";
        listContainer.append(loading);
      } else if (state.chats.error) {
        const error = document.createElement("p");
        error.className = "wm-chat-status wm-chat-error";
        error.textContent = state.chats.error;
        listContainer.append(error);
      } else if (state.chats.items.length === 0) {
        const empty = document.createElement("p");
        empty.className = "wm-chat-status";
        empty.textContent = "No chats yet. Click 'New Chat' to start.";
        listContainer.append(empty);
      } else {
        const list = document.createElement("ul");
        list.className = "wm-chat-items";

        for (const chat of state.chats.items) {
          const item = document.createElement("li");
          item.className = "wm-chat-item";

          const link = document.createElement("a");
          link.href = buildChatUrl(chat.id);
          link.className = "wm-chat-item-link";
          link.addEventListener("click", (e) => {
            e.preventDefault();
            navigateToChat(chat.id);
          });

          const name = document.createElement("span");
          name.className = "wm-chat-item-name";
          name.textContent = chat.name || "Untitled Chat";

          const model = document.createElement("span");
          model.className = "wm-chat-item-model";
          model.textContent = chat.model;

          link.append(name, model);

          const deleteBtn = document.createElement("button");
          deleteBtn.className = "wm-button secondary wm-chat-item-delete";
          deleteBtn.textContent = "Delete";
          deleteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            deleteChat(chat.id);
          });

          item.append(link, deleteBtn);
          list.append(item);
        }

        listContainer.append(list);
      }

      wrapper.append(listContainer);
      return wrapper;
    }

    state.activeChatId = chatId;

    if (!state.chatConversations.has(chatId)) {
      void loadChatMessages(chatId);
    }

    const chat = state.chats.items.find((c) => c.id === chatId);
    const chatName = chat?.name || "Chat";
    const chatModel = chat?.model || "Unknown";

    const header = document.createElement("div");
    header.className = "wm-chat-header";

    const backBtn = document.createElement("button");
    backBtn.className = "wm-button secondary";
    backBtn.textContent = "\u2190 Back";
    backBtn.addEventListener("click", () => navigateToChat(null));

    const titleContainer = document.createElement("div");
    titleContainer.className = "wm-chat-title-container";

    const title = document.createElement("h2");
    title.className = "wm-chat-title";
    title.textContent = chatName;

    const modelBadge = document.createElement("span");
    modelBadge.className = "wm-chat-model-badge";
    modelBadge.textContent = chatModel;

    titleContainer.append(title, modelBadge);
    header.append(backBtn, titleContainer);
    wrapper.append(header);

    const main = document.createElement("section");
    main.className = "wm-card wm-chat-main";

    const scrollRegion = document.createElement("div");
    scrollRegion.className = "wm-chat-scroll";

    scrollRegion.append(renderChatConversation(chatId));
    main.append(scrollRegion);
    wrapper.append(main);

    wrapper.append(renderChatComposer(chatId));

    requestAnimationFrame(() => {
      const scrollEl = wrapper.querySelector(".wm-chat-scroll");
      if (scrollEl) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
      }
    });

    return wrapper;
  };

  return {
    loadChats,
    loadChatMessages,
    navigateToChat,
    openPrivateChatDialog,
    deleteChat,
    renderChat,
  };
}
