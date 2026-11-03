import { describe, expect, test } from 'bun:test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

import { applyFlightDeckMentions, canonicalMentionTag, parseFlightDeckMentions } from './flightdeck-mentions';

const npub = () => nip19.npubEncode(getPublicKey(generateSecretKey()));

describe('structured Flight Deck mentions for agent writes', () => {
  test('explicit mentions become structured metadata and a matching visible tag is derived when missing', () => {
    const agent = npub();
    const result = applyFlightDeckMentions('Please take this.', [{ type: 'agent', npub: agent, label: 'Brick' }]);
    if ('error' in result) throw new Error(result.error);
    expect(result.metadata).toEqual({ mentions: [{ type: 'agent', npub: agent, label: 'Brick' }] });
    expect(result.body).toBe(`@[Brick](mention:agent:${agent}) Please take this.`);
    expect(result.warnings).toEqual([]);
  });

  test('an existing canonical tag is kept as-is (no duplicate) and duplicates collapse', () => {
    const agent = npub();
    const mention = { type: 'agent' as const, npub: agent, label: 'Violet' };
    const body = `${canonicalMentionTag(mention)} continue`;
    const result = applyFlightDeckMentions(body, [mention, mention]);
    if ('error' in result) throw new Error(result.error);
    expect(result.body).toBe(body);
    expect(result.metadata?.mentions).toHaveLength(1);
  });

  test('a visible tag without a structured entry is reported, never promoted to routing authority', () => {
    const agent = npub();
    const result = applyFlightDeckMentions(`@[Piper](mention:agent:${agent}) hi`, undefined);
    if ('error' in result) throw new Error(result.error);
    expect(result.metadata).toBeNull();
    expect(result.warnings[0]).toContain(agent);
  });

  test('invalid mentions are rejected explicitly', () => {
    expect(parseFlightDeckMentions('npub1x')).toHaveProperty('error');
    expect(parseFlightDeckMentions([{ type: 'agent', npub: 'npub1notvalid', label: 'X' }])).toHaveProperty('error');
    expect(parseFlightDeckMentions([{ type: 'task', npub: npub(), label: 'X' }])).toHaveProperty('error');
    expect(parseFlightDeckMentions([{ type: 'agent', npub: npub(), label: 'Bad](x' }])).toHaveProperty('error');
    expect(parseFlightDeckMentions([{ type: 'agent', npub: npub(), label: '' }])).toHaveProperty('error');
  });
});
