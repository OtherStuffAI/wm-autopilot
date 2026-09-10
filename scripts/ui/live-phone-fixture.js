// Browser fixture: production renderer and Dexie subscriptions, isolated transport.
import { initLiveView } from "/views/live-view.js";
import { state } from "/state/index.js";
import { initAgentIndicators } from "/status/agent-indicators.js";
import { initAlpineChat, Alpine } from "/live/chat-component.js";
import { db, MessageStore, PromptQueueStore } from "/live/db.js";
import { sseManager } from "/live/sse-manager.js";
import { initLiveMobileRuntime } from "/live/mobile-runtime.js";
import { scrollConversationAreaToBottom } from "/core/icons.js";

const sessionId = "phone-layout-regression";
const session = { id: sessionId, name: "Compact phone review", agent: "codex", status: "running", agentRuntimeStatus: "running", workingDirectory: "/workspace/autopilot" };
const sessions = { items: [session], activeSessionId: sessionId };
const noop = () => {};
const root = document.querySelector("#app");
root.dataset.route = "live";
document.body.dataset.authenticated = "true";
document.body.dataset.theme = "light";
await db.open();
await db.messages.clear();
await db.promptQueue.clear();
for (const [index, [role, content]] of [
  ["user", "Keep compact text and balanced padding."],
  ["assistant", "A real rendered reply with **bold text**, a [long link](https://example.com/very/long/path/for/mobile/validation) and code.\n\n```js\nconst ready = true;\n```"],
  ["agent-thinking", "Check the viewport, layout ancestors and composer bounds."],
  ["agent-tools", "Read the layout stylesheet."],
].entries()) {
  await MessageStore.upsertMessage(sessionId, { role, content, messageId: `message-${index}`, createdAt: `2026-09-10T13:18:0${index}Z` });
}
await PromptQueueStore.upsert(sessionId, { id: "queued-1", content: "Can you check why the message box doesn't stick to the bottom of the viewport as well please.", timestamp: "2026-09-10T13:18:21Z", order: 1 });
sseManager.connect = noop;
initAlpineChat();
const chat = Alpine.store("chat");
chat._syncMessagesFromServer = noop;
chat._syncPermissionsFromServer = noop;
chat._syncPromptQueueFromServer = noop;
const indicators = initAgentIndicators({ state, sessionsStore: () => sessions, getCurrentRoute: () => "live", getQueueCount: () => 1, isSessionBusy: () => true, openPromptQueueModal: noop });
let view;
function render() {
  root.replaceChildren(view.renderLive());
  document.querySelector(".wm-knight-rider")?.classList.add("active");
}
view = initLiveView(new Proxy({
  sessionsStore: () => sessions, appsStore: () => ({ items: [] }), appRoot: root,
  getCurrentRoute: () => "live", getTabsVisible: () => true,
  getTaskDispatchTabsVisible: () => true, getLiveHeaderCollapsed: () => document.body.dataset.liveHeaderCollapsed === "true",
  toggleLiveHeaderCollapsed: () => { document.body.dataset.liveHeaderCollapsed = String(document.body.dataset.liveHeaderCollapsed !== "true"); },
  getRawTerminalOutputVisible: () => false, getActiveSessions: () => sessions.items,
  getSessionIdFromPath: () => sessionId, isFeatureEnabledForViewer: () => false,
  createAgentStatusIndicator: indicators.createAgentStatusIndicator,
  scrollConversationAreaToBottom: () => scrollConversationAreaToBottom(sessionId, new Map()), render,
}, { get: (target, key) => key in target ? target[key] : noop }));
initLiveMobileRuntime();
window.layoutFixture = {
  async mount(split = false) {
    state.artifactsLayout.open = split;
    state.artifactsLayout.sessionId = split ? sessionId : null;
    // Use the real per-session layout state, as the menu does.
    const { setArtifactsPanelOpenForSession } = await import("/live/writer-panel-state.js");
    setArtifactsPanelOpenForSession(state, sessionId, split);
    render();
  },
  async short() {
    await db.messages.clear();
  },
  async fill() {
    for (let i = 0; i < 20; i++) {
      await MessageStore.upsertMessage(sessionId, { role: i % 2 ? "assistant" : "user", content: `Conversation scrolling regression ${i}. `.repeat(12), messageId: `long-${i}`, createdAt: new Date(Date.UTC(2026, 8, 10, 13, 19, i)).toISOString() });
    }
  },
};
await window.layoutFixture.mount(new URL(location.href).searchParams.has("split"));
window.fixtureReady = true;
