/**
 * Toast notification system for displaying transient messages.
 */

import { TOAST_DEFAULT_DURATION_MS } from "../state/index.js";

let toastContainer = null;

/**
 * Ensures the toast container exists in the DOM.
 * @returns {HTMLElement} The toast container element
 */
function ensureToastContainer() {
  if (toastContainer && document.body.contains(toastContainer)) {
    return toastContainer;
  }
  toastContainer = document.createElement("div");
  toastContainer.className = "wm-toast-container";
  document.body.append(toastContainer);
  return toastContainer;
}

/**
 * Displays a toast notification.
 * @param {string} message - The message to display
 * @param {Object|string} options - Configuration options or a variant/type string
 * @param {string} [options.variant="info"] - Toast variant
 * @param {string} [options.type] - Alias for variant
 * @param {number} [options.duration] - Duration in ms before auto-dismiss
 */
export function showToast(message, options = {}) {
  if (!message) return;
  const normalizedOptions =
    typeof options === "string"
      ? { variant: options }
      : options && typeof options === "object"
        ? options
        : {};
  const requestedVariant =
    typeof normalizedOptions.type === "string" && normalizedOptions.type.trim().length > 0
      ? normalizedOptions.type.trim()
      : typeof normalizedOptions.variant === "string" && normalizedOptions.variant.trim().length > 0
        ? normalizedOptions.variant.trim()
        : "info";
  const variant =
    requestedVariant === "error" ||
    requestedVariant === "success" ||
    requestedVariant === "warning"
      ? requestedVariant
      : "info";
  const duration =
    typeof normalizedOptions.duration === "number" &&
    Number.isFinite(normalizedOptions.duration) &&
    normalizedOptions.duration > 0
      ? normalizedOptions.duration
      : TOAST_DEFAULT_DURATION_MS;
  const container = ensureToastContainer();
  const toast = document.createElement("div");
  toast.className = `wm-toast wm-toast--${variant}`;
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.textContent = message;
  container.append(toast);
  requestAnimationFrame(() => {
    toast.classList.add("is-visible");
  });
  const removeToast = () => {
    toast.remove();
  };
  const scheduleRemoval = () => {
    toast.classList.remove("is-visible");
    toast.addEventListener("transitionend", removeToast, { once: true });
    setTimeout(removeToast, 400);
  };
  setTimeout(scheduleRemoval, duration);
}
