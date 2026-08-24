/**
 * Chat dialog component for creating new private chat sessions.
 * Provides model selection and chat name input.
 */

import { fetchModelsApi, createChatApi } from "../services/chats.js";

/** Default models to show if API fetch fails */
const DEFAULT_MODELS = [
  "llama-3.3-70b",
  "gpt-oss-120b",
  "deepseek-r1-0528",
  "kimi-k2-thinking",
  "qwen3-vl-30b",
  "qwen3-coder-480b",
];

/**
 * Creates the chat dialog controller.
 * @param {Object} options
 * @param {Function} options.onCreated - Called with the new chat when created
 * @param {Function} options.showToast - Toast notification function
 * @returns {Object} Dialog controller
 */
export function createChatDialogController({ onCreated, showToast }) {
  let dialogEl = null;
  let models = [...DEFAULT_MODELS];
  let modelsLoaded = false;

  /**
   * Loads available models from the API.
   */
  async function loadModels() {
    if (modelsLoaded) return;

    try {
      const result = await fetchModelsApi();
      if (result?.models && Array.isArray(result.models)) {
        models = result.models;
        modelsLoaded = true;
        updateModelSelect();
      }
    } catch (err) {
      console.warn("[chat-dialog] Failed to load models:", err);
    }
  }

  /**
   * Updates the model select options.
   */
  function updateModelSelect() {
    if (!dialogEl) return;
    const select = dialogEl.querySelector("[data-chat-model]");
    if (!select) return;

    const currentValue = select.value;
    select.innerHTML = "";

    for (const model of models) {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      if (model === currentValue || (!currentValue && model === models[0])) {
        option.selected = true;
      }
      select.append(option);
    }
  }

  /**
   * Creates the dialog element.
   */
  function createDialog() {
    const dialog = document.createElement("dialog");
    dialog.className = "wm-dialog wm-chat-dialog";
    dialog.innerHTML = `
      <form method="dialog" class="wm-dialog-content">
        <header class="wm-dialog-header">
          <h2>New Private Chat</h2>
          <button type="button" class="wm-dialog-close" data-close aria-label="Close">&times;</button>
        </header>
        <div class="wm-dialog-body">
          <div class="wm-form-group">
            <label for="chat-name-input">Chat Name (optional)</label>
            <input
              type="text"
              id="chat-name-input"
              data-chat-name
              class="wm-input"
              placeholder="My conversation..."
              autocomplete="off"
            />
          </div>
          <div class="wm-form-group">
            <label for="chat-model-select">Model</label>
            <select id="chat-model-select" data-chat-model class="wm-select">
              ${models.map((m, i) => `<option value="${m}"${i === 0 ? " selected" : ""}>${m}</option>`).join("")}
            </select>
          </div>
        </div>
        <footer class="wm-dialog-footer">
          <button type="button" class="wm-button secondary" data-close>Cancel</button>
          <button type="submit" class="wm-button" data-submit>Start Chat</button>
        </footer>
      </form>
    `;

    // Close button handler
    dialog.querySelectorAll("[data-close]").forEach((btn) => {
      btn.addEventListener("click", () => {
        dialog.close();
      });
    });

    // Form submission
    const form = dialog.querySelector("form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      await handleCreate();
    });

    // Close on backdrop click
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) {
        dialog.close();
      }
    });

    return dialog;
  }

  /**
   * Handles chat creation.
   */
  async function handleCreate() {
    if (!dialogEl) return;

    const nameInput = dialogEl.querySelector("[data-chat-name]");
    const modelSelect = dialogEl.querySelector("[data-chat-model]");
    const submitBtn = dialogEl.querySelector("[data-submit]");

    const name = nameInput?.value?.trim() || "";
    const model = modelSelect?.value || models[0];

    // Disable submit while creating
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Creating...";
    }

    try {
      const result = await createChatApi(name, model);
      if (result?.chat) {
        dialogEl.close();
        if (nameInput) nameInput.value = "";
        onCreated?.(result.chat);
      } else {
        showToast?.("Failed to create chat", "error");
      }
    } catch (err) {
      console.error("[chat-dialog] Create error:", err);
      showToast?.(err.message || "Failed to create chat", "error");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Start Chat";
      }
    }
  }

  /**
   * Opens the dialog.
   */
  function open() {
    if (!dialogEl) {
      dialogEl = createDialog();
      document.body.append(dialogEl);
    }

    // Load models in background
    loadModels();

    dialogEl.showModal();

    // Focus name input
    const nameInput = dialogEl.querySelector("[data-chat-name]");
    if (nameInput) {
      nameInput.focus();
    }
  }

  /**
   * Closes the dialog.
   */
  function close() {
    dialogEl?.close();
  }

  /**
   * Returns whether the dialog is open.
   */
  function isOpen() {
    return dialogEl?.open ?? false;
  }

  return {
    open,
    close,
    isOpen,
    loadModels,
  };
}
