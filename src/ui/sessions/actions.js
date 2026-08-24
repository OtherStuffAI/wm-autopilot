/**
 * Session action handlers.
 *
 * Thin wrappers that call session APIs and sync changes to Dexie.
 * After each action the sessions Alpine store is synced so the liveQuery
 * fires and Alpine reactivity updates the DOM.
 */

import Alpine from "/vendor/alpinejs/module.esm.js";
import { ApiSessionStore } from "../live/db.js";
import {
  stopSessionApi,
  deleteSessionApi,
  updateSessionNameApi,
  resumeNativeSessionApi,
  forkSessionToWorktreeApi,
} from "../services/sessions.js";
import { createSessionActions } from "./actions-core.js";

/** Get the sessions store (safe to call after Alpine.start). */
function getStore() {
  return Alpine.store("sessions");
}

const sessionActions = createSessionActions({
  getStore,
  apiSessionStore: ApiSessionStore,
  stopSessionApi,
  deleteSessionApi,
  updateSessionNameApi,
  resumeNativeSessionApi,
  forkSessionToWorktreeApi,
});

export const {
  stopSession,
  deleteSession,
  renameSession,
  resumeNativeSession,
  forkToWorktree,
} = sessionActions;
