import type { AgentDefinitionRecord, InboundCommentRecord } from './types';

function compactText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function truncateText(value: string, maxLength = 400): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '[empty]';
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function formatRuntimeContextBlock(value: string | null | undefined): string {
  const trimmed = compactText(value);
  return trimmed ? `\n\nProfile workspace runtime context:\n${trimmed}` : '';
}

export function buildDocumentCommentRoute(docId: string, commentId: string): string {
  const params = new URLSearchParams();
  params.set('docid', docId);
  params.set('commentid', commentId);
  return `/docs?${params.toString()}`;
}

export function buildDocumentCommentDispatchPrompt(params: {
  agent: AgentDefinitionRecord;
  comment: InboundCommentRecord;
  documentId: string;
  documentRoute: string;
  commands: {
    sync: string;
    show: string;
    reply: string;
  };
  runtimeContext?: string | null;
}): string {
  const body = truncateText(params.comment.body);
  const anchorLine = Number.isFinite(params.comment.anchorLineNumber ?? NaN)
    ? String(params.comment.anchorLineNumber)
    : '-';

  const prompt = [
    'Agent comment dispatch.',
    'Dispatch reason: document comment added.',
    `Agent id: ${params.agent.agentId}`,
    `Document id: ${params.documentId}`,
    `Comment id: ${params.comment.commentId}`,
    `Thread id: ${params.comment.parentCommentId ?? params.comment.commentId}`,
    `Sender npub: ${compactText(params.comment.senderNpub) || 'unknown'}`,
    `Anchor line: ${anchorLine}`,
    `Comment status: ${params.comment.commentStatus}`,
    `Document link: ${params.documentRoute}`,
    'Comment body:',
    body,
    '',
    'Yoke commands:',
    `- Sync workspace state: ${params.commands.sync}`,
    `- Review the current document: ${params.commands.show}`,
    `- Reply in the current comment thread: ${params.commands.reply}`,
    '',
    'Instructions:',
    '- Sync first so you review current state, not transcript memory.',
    '- Inspect the document before replying.',
    '- Answer in the existing comment thread, not in the Wingman chat transcript.',
    '- If the comment implies new work, state that clearly in the reply and continue the session.',
    '- If no further work is needed after replying, set nextAction to stop.',
  ].join('\n');
  return `${prompt}${formatRuntimeContextBlock(params.runtimeContext)}`;
}
