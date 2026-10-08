import { MessageStore } from "./db.js";
import { fetchSessionMessagesApi } from "../services/sessions.js";
import { getSessionHistoryLoader } from "./session-history-loader.js";

export const sessionHistorySync = getSessionHistoryLoader({
  fetchMessages: fetchSessionMessagesApi,
  store: MessageStore,
});
