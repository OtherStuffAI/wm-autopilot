const INTERACTIVE_SELECTOR = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[contenteditable="true"]',
  '[role="button"]',
  '[data-working-notes-ignore-toggle]',
].join(',');

let attached = false;
const panelOpenState = new Map();
let preferences = null;

function getElementTarget(target) {
  if (target instanceof Element) {
    return target;
  }
  if (target instanceof Node && target.parentElement) {
    return target.parentElement;
  }
  return null;
}

function isHTMLElement(value) {
  return value instanceof HTMLElement;
}

function shouldIgnoreTarget(target) {
  const element = getElementTarget(target);
  return isHTMLElement(element) && Boolean(element.closest(INTERACTIVE_SELECTOR));
}

function findWorkingNotesPanel(target) {
  const element = getElementTarget(target);
  if (!isHTMLElement(element)) {
    return null;
  }
  const bubble = element.closest('.wm-message[data-role="agent-working"], .wm-message[data-role="agent-thinking"], .wm-message[data-role="agent-tools"], .wm-message[data-role="agent-context"]');
  if (!bubble) {
    return null;
  }
  return bubble.querySelector('[data-working-notes-panel]');
}

function isWorkingNotesCloseControl(target) {
  const element = getElementTarget(target);
  return isHTMLElement(element) && Boolean(element.closest('[data-working-notes-close]'));
}

function togglePanel(panel) {
  if (!(panel instanceof HTMLDetailsElement)) {
    return false;
  }
  panel.open = !panel.open;
  return true;
}

function getPanelKey(panel) {
  return typeof panel?.dataset?.workingNotesKey === 'string' && panel.dataset.workingNotesKey.length > 0
    ? panel.dataset.workingNotesKey
    : null;
}

function rememberPanelState(panel, userInteraction = false) {
  if (!preferences && !userInteraction) return;
  if (!(panel instanceof HTMLDetailsElement)) {
    return;
  }
  const key = getPanelKey(panel);
  if (!key) {
    return;
  }
  if (panelOpenState.get(key) === panel.open) return;
  panelOpenState.set(key, panel.open);
  preferences?.writeWorkingNotesPreference(key, panel.open)
    .catch((error) => console.error("[chat] Failed to save panel expansion", error));
}

export function getWorkingNotesPanelKey(sessionId, message) {
  const sid = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'session';
  const messageKey =
    (message?.displayGroup ? message.id : null) ??
    message?.turnId ??
    message?.turn_id ??
    message?.createdAt ??
    message?.created_at ??
    message?.messageId ??
    message?.message_id ??
    message?.id ??
    `${message?.role ?? message?.type ?? 'agent-working'}:${String(message?.content ?? message?.message ?? '').slice(0, 64)}`;
  return `${sid}:${messageKey}`;
}

export function getWorkingNotesPanelState(key) {
  return panelOpenState.get(key);
}

export function isWorkingNotesPanelOpen(key, defaultOpen = false) {
  return panelOpenState.has(key) ? panelOpenState.get(key) === true : defaultOpen;
}

export function attachWorkingNotesToggle(root = document) {
  if (attached || !root?.addEventListener) {
    return;
  }
  attached = true;
  import("./working-notes-preferences.js").then(async (store) => {
    const saved = await store.readWorkingNotesPreferences();
    const touched = new Map(panelOpenState);
    for (const [key, open] of saved) {
      // A user interaction during hydration takes precedence over saved state.
      if (!panelOpenState.has(key)) panelOpenState.set(key, open);
    }
    for (const [key, open] of touched) await store.writeWorkingNotesPreference(key, open);
    preferences = store;
    root.querySelectorAll?.('[data-working-notes-panel]').forEach((panel) => {
      const key = getPanelKey(panel);
      if (panelOpenState.has(key)) panel.open = panelOpenState.get(key);
    });
  }).catch((error) => console.error("[chat] Failed to read panel expansion", error));
  root.addEventListener('click', (event) => {
    if (isWorkingNotesCloseControl(event.target)) {
      const panel = findWorkingNotesPanel(event.target);
      if (panel instanceof HTMLDetailsElement) {
        panel.open = false;
        rememberPanelState(panel, true);
        event.preventDefault();
      }
      return;
    }
    if (event.defaultPrevented || shouldIgnoreTarget(event.target)) {
      return;
    }
    const panel = findWorkingNotesPanel(event.target);
    if (!(panel instanceof HTMLDetailsElement) || panel.open) {
      return;
    }
    panel.open = true;
    rememberPanelState(panel, true);
    event.preventDefault();
  });
  root.addEventListener('dblclick', (event) => {
    if (event.defaultPrevented || shouldIgnoreTarget(event.target)) {
      return;
    }
    const panel = findWorkingNotesPanel(event.target);
    if (!panel || !togglePanel(panel)) {
      return;
    }
    rememberPanelState(panel, true);
    event.preventDefault();
  });
  root.addEventListener('toggle', (event) => {
    if (event.target instanceof HTMLDetailsElement && event.target.matches('[data-working-notes-panel]')) {
      rememberPanelState(event.target);
    }
  }, true);
}
