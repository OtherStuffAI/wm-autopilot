import type { AgentDefinitionRecord, InboundCommentRecord } from './types';

export type CommentDispatchTarget = 'task' | 'document';

export interface DisabledCommentDispatchDecision {
  action: 'task_comment_dispatch_disabled' | 'document_comment_dispatch_disabled';
  details: Record<string, unknown>;
}

export class AgentCommentDispatchRuntime {
  handleDisabledDispatch(input: {
    target: CommentDispatchTarget;
    agent: AgentDefinitionRecord;
    comment: InboundCommentRecord;
    updaterNpub: string | null;
  }): DisabledCommentDispatchDecision {
    return {
      action: input.target === 'task'
        ? 'task_comment_dispatch_disabled'
        : 'document_comment_dispatch_disabled',
      details: {
        comment_id: input.comment.commentId,
        updater_npub: input.updaterNpub,
        sender_npub: input.comment.senderNpub,
        target_record_family_hash: input.comment.targetRecordFamilyHash,
        disabled_reason: 'comment_dispatch_stubbed',
        note: 'Comment dispatch is configured separately from task dispatch but execution is disabled.',
      },
    };
  }
}

export const agentCommentDispatchRuntime = new AgentCommentDispatchRuntime();
