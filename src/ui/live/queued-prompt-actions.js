import {
  removeFromSessionQueueApi,
  updateSessionQueuePromptApi,
} from "../services/sessions.js";
import { PromptQueueStore } from "./db.js";

export async function saveQueuedPromptEdit(sessionId, promptId, content) {
  const payload = await updateSessionQueuePromptApi(sessionId, promptId, content);
  if (Array.isArray(payload?.queue?.prompts)) {
    await PromptQueueStore.replaceSession(sessionId, payload.queue.prompts);
    return;
  }
  await PromptQueueStore.updateContent(sessionId, promptId, content);
}

export async function deleteQueuedPrompt(sessionId, promptId) {
  const payload = await removeFromSessionQueueApi(sessionId, promptId);
  if (Array.isArray(payload?.queue?.prompts)) {
    await PromptQueueStore.replaceSession(sessionId, payload.queue.prompts);
    return;
  }
  await PromptQueueStore.remove(sessionId, promptId);
}
