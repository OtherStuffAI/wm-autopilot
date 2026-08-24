import type { AgentInterceptDecision } from './types';

export interface ParsedAgentChatReply {
  decision: AgentInterceptDecision;
  replyBody: string;
}

const DECISION_PREFIX = 'AGENT_CHAT_DECISION:';
const LEADING_MARKER_PATTERN = /^(?:[-*•]|\d+[.)]|>)+\s*/;

function normaliseDecision(value: string): AgentInterceptDecision {
  switch (value.trim().toLowerCase()) {
    case 'respond':
      return 'respond';
    case 'ignore':
      return 'ignore';
    default:
      return 'failed';
  }
}

function parseFallbackDecision(firstLine: string): AgentInterceptDecision {
  const trimmed = firstLine.trim();
  if (!trimmed) {
    return 'failed';
  }
  const normalised = trimmed.toLowerCase();
  if (/^(respond|ignore)\b/.test(normalised)) {
    return normaliseDecision(normalised);
  }
  const decisionMatch = normalised.match(/^(?:decision:\s*)?(?:i\s+(?:should|will)\s+)?(respond|ignore)\b/);
  return decisionMatch ? normaliseDecision(decisionMatch[1] ?? '') : 'failed';
}

function normaliseDecisionCandidate(line: string): string {
  return line.trim().replace(LEADING_MARKER_PATTERN, '').trim();
}

function findExplicitDecisionLine(lines: string[]): { decision: AgentInterceptDecision; index: number } | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = normaliseDecisionCandidate(lines[index] ?? '');
    if (!candidate.startsWith(DECISION_PREFIX)) {
      continue;
    }
    return {
      decision: normaliseDecision(candidate.slice(DECISION_PREFIX.length)),
      index,
    };
  }
  return null;
}

export function parseAgentChatReply(content: string): ParsedAgentChatReply {
  const trimmed = content.trim();
  if (!trimmed) {
    return {
      decision: 'failed',
      replyBody: '',
    };
  }

  const lines = trimmed.split(/\r?\n/);
  const explicitDecision = findExplicitDecisionLine(lines);
  if (explicitDecision) {
    return {
      decision: explicitDecision.decision,
      replyBody: lines
        .slice(explicitDecision.index + 1)
        .join('\n')
        .trim(),
    };
  }

  const firstLine = lines[0]?.trim() ?? '';
  if (!firstLine.startsWith(DECISION_PREFIX)) {
    const fallbackDecision = parseFallbackDecision(firstLine);
    return {
      decision: fallbackDecision,
      replyBody: lines
        .slice(1)
        .join('\n')
        .trim(),
    };
  }

  const decision = normaliseDecision(firstLine.slice(DECISION_PREFIX.length));
  const replyBody = lines
    .slice(1)
    .join('\n')
    .trim();

  return {
    decision,
    replyBody,
  };
}
