import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./chat-component.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("live ACP permission and queue surface", () => {
  test("keeps the waiting state and accessible runtime-backed actions by the active composer edge", () => {
    expect(source).toContain('data-testid="waiting-for-permission">Waiting for permission');
    expect(source).toContain('aria-label="Agent permission requests"');
    expect(source).toContain('aria-live="assertive"');
    expect(source).toContain('$store.chat.getPermissionActions(permission)');
    expect(source.indexOf('class="wm-permission-requests"')).toBeGreaterThan(
      source.indexOf('x-ref="chatContainer" class="wm-conversation"'),
    );
    const permissionStyles = styles.slice(styles.indexOf(".wm-permission-requests"), styles.indexOf(".wm-permission-card"));
    expect(permissionStyles).toContain("position: sticky");
    expect(permissionStyles).toContain("bottom: 0");
  });

  test("keeps a permission visible until its server response succeeds", () => {
    const respondingStart = source.indexOf("async respondToPermission(permission, response)");
    const respondingEnd = source.indexOf("async respondToQuestion", respondingStart);
    const respondingSource = source.slice(respondingStart, respondingEnd);
    expect(respondingSource.indexOf("await respondToSessionPermissionApi")).toBeLessThan(
      respondingSource.indexOf("await PermissionStore.remove"),
    );
    expect(respondingSource).toContain("await PermissionStore.setResponding(sessionId, permission.permissionId, false)");
  });

  test("hydrates queued prompts from the server into Dexie and labels their timeline projection", () => {
    expect(source).toContain("fetchSessionQueueApi(sessionId)");
    expect(source).toContain("PromptQueueStore.replaceSession(sessionId, payload.queue.prompts)");
    expect(source).toContain('data-testid="queued-prompt-state">Queued');
    expect(source).toContain("mergeConversationWithQueuedPrompts(this.messages, this.queuedPrompts)");
  });
});
