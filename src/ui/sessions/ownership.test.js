import { describe, expect, test } from 'bun:test';

import { resolveSessionOwnerNpub } from './ownership.js';

describe('resolveSessionOwnerNpub', () => {
  test('prefers explicit ownerNpub on the session payload', () => {
    expect(
      resolveSessionOwnerNpub({
        npub: 'npub1runtime',
        ownerNpub: 'npub1owner',
        metadata: { ownerNpub: 'npub1metadata' },
      }),
    ).toBe('npub1owner');
  });

  test('falls back to metadata ownerNpub before raw npub', () => {
    expect(
      resolveSessionOwnerNpub({
        npub: 'npub1runtime',
        metadata: { ownerNpub: 'npub1owner' },
      }),
    ).toBe('npub1owner');
  });
});

test('installation operator filter includes app execution without changing ownership',async()=>{
 const {sessionMatchesOwnerFilter}=await import('./ownership.js');
 const session={ownerNpub:'npub1app',executionOperatorNpub:'npub1operator'};
 expect(resolveSessionOwnerNpub(session)).toBe('npub1app');
 expect(sessionMatchesOwnerFilter(session,'npub1operator')).toBe(true);
 expect(sessionMatchesOwnerFilter(session,'npub1app')).toBe(true);
 expect(sessionMatchesOwnerFilter(session,'npub1foreign')).toBe(false);
});
