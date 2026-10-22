import { afterEach, expect, test } from 'bun:test';
import { generateSecretKey, nip19 } from 'nostr-tools';
import { createAgentProfileKeyExport } from './agent-profile-key-export.js';
import { createProfileCard } from './agent-profile-card.js';
import { createProjectStaticAssetService } from '../../../server/static-assets.ts';

class Element {
  children = [];
  dataset = {};
  style = {};
  listeners = new Map();
  value = '';
  open = false;
  constructor(tag) { this.tagName = tag; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { if (name === "data-testid") this.dataset.testid = value; }
  addEventListener(event, listener) { this.listeners.set(event, listener); }
  async emit(event, input = {}) { await this.listeners.get(event)?.({ preventDefault() {}, ...input }); }
  click() { return this.emit('click'); }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; void this.emit('close'); }
}
function find(element, id) {
  if (element.dataset.testid === id) return element;
  for (const child of element.children) { const result = find(child, id); if (result) return result; }
  return null;
}
const originalDocument = globalThis.document;
afterEach(() => { globalThis.document = originalDocument; });
function setup(fetchKey) {
  globalThis.document = { createElement: tag => new Element(tag) };
  const modal = createAgentProfileKeyExport({ fetchKey });
  const get = suffix => find(modal.element, `agent-profile-export-${suffix}`);
  return { ...modal, get };
}
const first = { agentId: 'first', label: 'First bot', botNpub: 'npub1first' };
const second = { agentId: 'second', label: 'Second bot', botNpub: 'npub1second' };

test('cancel and Escape never fetch a key; warning identifies selected bot', async () => {
  let requests = 0;
  const modal = setup(async () => { requests++; });
  modal.open(second);
  expect(modal.get('identity').textContent).toContain('Second bot (second) — npub1second');
  expect(modal.element.children[2].textContent).toContain('can control this bot');
  expect(modal.element.children[2].textContent).toContain('Store it securely');
  await modal.get('cancel').click();
  modal.open(first);
  await modal.element.emit('cancel');
  expect(requests).toBe(0);
  expect(modal.get('key').value.length).toBe(0);
});

test('explicit confirmation sends exact selected bot; dismissal clears transient result', async () => {
  let sent;
  const secret = generateSecretKey();
  let fixtureKey = nip19.nsecEncode(secret);
  secret.fill(0);
  const modal = setup(async (url, options) => {
    sent = { url, options };
    return Response.json({ profileId: 'second', botNpub: second.botNpub, nsec: fixtureKey });
  });
  modal.open(first);
  modal.open(second);
  await modal.get('confirm').click();
  expect(sent.url).toBe('/api/agent-chat/profiles/second/export-nsec');
  expect(JSON.parse(sent.options.body)).toEqual({ confirmation: { profileId: 'second', currentNpub: second.botNpub, acknowledged: true } });
  expect(sent.options.cache).toBe('no-store');
  expect(modal.get('key').value === fixtureKey).toBe(true);
  await modal.get('cancel').click();
  fixtureKey = null;
  expect(modal.get('key').value.length).toBe(0);
  expect(modal.get('identity').textContent).toBe('');
  expect(modal.element.open).toBe(false);
});

test('cancel during request aborts and ignores late result after another bot is selected', async () => {
  let release;
  let signal;
  const modal = setup((_url, options) => {
    signal = options.signal;
    return new Promise(resolve => { release = resolve; });
  });
  modal.open(first);
  const pending = modal.get('confirm').click();
  await modal.get('cancel').click();
  modal.open(second);
  release(Response.json({ profileId: 'first', botNpub: first.botNpub, nsec: 'not-a-key' }));
  await pending;
  expect(signal.aborted).toBe(true);
  expect(modal.get('key').value.length).toBe(0);
  expect(modal.get('identity').textContent).toContain('second');
  expect(modal.get('confirm').hidden).toBe(false);
});

test('mismatched selected-bot response is never displayed and error body is not forwarded', async () => {
  const modal = setup(async () => Response.json({ profileId: 'first', botNpub: first.botNpub, nsec: 'not-a-key', error: 'private fixture detail' }));
  modal.open(second);
  await modal.get('confirm').click();
  expect(modal.get('key').value.length).toBe(0);
  expect(modal.element.children[3].textContent.includes('private fixture detail')).toBe(false);
});

test('export action fails closed independently of broader management permissions', () => {
  setup(async () => {});
  for (const allowed of [false, undefined]) {
    const card = createProfileCard(first, true, false, () => {}, () => {}, () => {}, () => {}, () => {}, allowed);
    expect(find(card, 'agent-profile-export-first')).toBeNull();
  }
  let selected;
  const card = createProfileCard(second, false, false, () => {}, () => {}, () => {}, () => {}, bot => { selected = bot; }, true);
  find(card, 'agent-profile-export-second').click();
  expect(selected).toBe(second);
});

test('new export UI module is served as JavaScript', () => {
  const assets = createProjectStaticAssetService(process.cwd());
  const response = assets.resolveUiAsset('/views/settings/agent-profile-key-export.js');
  expect(response?.status).toBe(200);
  expect(response?.headers.get('content-type')).toContain('application/javascript');
});
