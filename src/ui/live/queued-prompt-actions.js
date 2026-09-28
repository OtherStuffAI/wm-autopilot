import {
  removeFromSessionQueueApi,
  updateSessionQueuePromptApi,
} from "../services/sessions.js";
import { PromptQueueStore } from "./db.js";
import { openConfirmDialog } from "../common/dialog-prompts.js";

export async function saveQueuedPromptEdit(sessionId, promptId, content) {
  const payload = await updateSessionQueuePromptApi(sessionId, promptId, content);
  if (Array.isArray(payload?.queue?.prompts)) {
    await PromptQueueStore.replaceSession(sessionId, payload.queue.prompts);
    return;
  }
  await PromptQueueStore.updateContent(sessionId, promptId, content);
}

export async function deleteQueuedPrompt(sessionId, promptId) {
  const confirmed = await openConfirmDialog({
    title: "Delete Queued Prompt",
    description: "Remove this prompt from the session queue. This cannot be undone.",
    confirmLabel: "Delete",
    testId: "delete-queued-prompt-dialog",
  });
  if (!confirmed) return false;

  const payload = await removeFromSessionQueueApi(sessionId, promptId);
  if (Array.isArray(payload?.queue?.prompts)) {
    await PromptQueueStore.replaceSession(sessionId, payload.queue.prompts);
    return true;
  }
  await PromptQueueStore.remove(sessionId, promptId);
  return true;
}
