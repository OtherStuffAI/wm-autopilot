import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildDocumentDirectRoutingKey,
  normaliseDocumentDirectTrigger,
} from './document-direct-contract';

describe('document direct contract', () => {
  const towerFixtureDirectory = resolve(
    import.meta.dir,
    '../../../wingman-tower/fixtures/flightdeck-pg/document-agent-sessions',
  );
  const towerContractTest = existsSync(towerFixtureDirectory) ? test : test.skip;
  const towerFixture = (name: string) => JSON.parse(readFileSync(resolve(
    towerFixtureDirectory,
    `${name}.json`,
  ), 'utf8'));

  test('anchors routing to stable document identity', () => {
    expect(buildDocumentDirectRoutingKey({ towerServiceNpub: 'tower', workspaceId: 'workspace', agentId: 'exampleAgent', documentId: 'doc-1' }))
      .toBe('document-direct:v1:tower:workspace:exampleAgent:doc-1');
  });

  test('normalises ordered document and inline comment triggers', () => {
    const mention = normaliseDocumentDirectTrigger({
      event_id: 'event-1', event_type: 'document_mention_added', entity_type: 'document', entity_id: 'doc-1', operation: 'updated',
      payload: { document_id: 'doc-1', added_mentions: [{ type: 'agent', npub: 'npub-exampleAgent' }] },
    });
    const comment = normaliseDocumentDirectTrigger({
      event_id: 'event-2', event_type: 'document_comment_mention_added', entity_type: 'document_comment', entity_id: 'comment-1', operation: 'created',
      payload: { doc_id: 'doc-1', comment_id: 'comment-1', mentions: [{ type: 'agent', npub: 'npub-exampleAgent' }] },
    });
    expect(mention).toMatchObject({ documentId: 'doc-1', reason: 'document_mention_added', targetAgentNpubs: ['npub-exampleAgent'] });
    expect(comment).toMatchObject({ documentId: 'doc-1', reason: 'document_comment_mention_added', sourceCommentId: 'comment-1' });
  });

  test('normalises the existing default-agent full review dispatch', () => {
    expect(normaliseDocumentDirectTrigger({
      event_id: 'event-review', event_type: 'full_document_review_requested', entity_type: 'invocation', entity_id: 'invoke-1', operation: 'created',
      payload: { document_id: 'doc-1', agent: { type: 'agent', npub: 'npub-exampleAgent' } },
    })).toMatchObject({ documentId: 'doc-1', reason: 'full_document_review_requested', targetAgentNpubs: ['npub-exampleAgent'] });
  });

  towerContractTest('consumes Tower cfde7d1 committed serialized fixtures without synthetic fields', () => {
    const documentMention = towerFixture('document_mention_added');
    const commentMentions = towerFixture('document_comment_mention_added');
    const fullReview = towerFixture('full_document_review_requested');
    expect(normaliseDocumentDirectTrigger(documentMention.event)).toMatchObject({
      documentId: documentMention.event.payload.document_id,
      targetAgentNpubs: [documentMention.event.payload.added_mentions[0].npub],
      reason: 'document_mention_added',
    });
    expect(normaliseDocumentDirectTrigger(commentMentions.events[0])).toMatchObject({
      sourceCommentId: commentMentions.events[0].payload.comment_id,
      targetAgentNpubs: [commentMentions.events[0].payload.added_mentions[0].npub],
      reason: 'document_comment_mention_added',
    });
    expect(normaliseDocumentDirectTrigger(fullReview.event)).toMatchObject({
      documentId: fullReview.event.payload.document_id,
      targetAgentNpubs: [fullReview.event.payload.agent.npub],
      reason: 'full_document_review_requested',
    });
    expect(fullReview.movement.document_id_after).toBe(fullReview.movement.document_id_before);
    expect(fullReview.replay.new_event_emitted).toBe(false);
  });
});
