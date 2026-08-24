import type { AgentType } from '../config';
import type { SessionOrigin, SessionSnapshot } from '../agents/process-manager';
import type { SessionMetadataInput } from '../sessions/session-metadata';
import type {
  AgentDefinitionRecord,
  InboundCommentRecord,
  RuntimeBotIdentity,
  WorkspaceSubscriptionRecord,
} from './types';
import {
  buildAgentDocumentCommentYokeCommands,
  prepareAgentWorkspaceYokeRuntime,
  type AgentWorkspaceYokeRuntime,
} from './yoke-runtime';
import {
  buildDocumentCommentDispatchPrompt,
  buildDocumentCommentRoute,
} from './comment-prompts';

function compactText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isLiveSession(session: SessionSnapshot | null): session is SessionSnapshot {
  if (!session) {
    return false;
  }
  return session.status === 'running' || session.status === 'starting';
}

function isStoppedSession(session: SessionSnapshot | null): session is SessionSnapshot {
  if (!session) {
    return false;
  }
  return session.status === 'stopped' || session.status === 'error';
}

function buildDocumentCommentKey(
  subscription: WorkspaceSubscriptionRecord,
  agent: AgentDefinitionRecord,
  documentId: string,
): string {
  return [
    subscription.workspaceOwnerNpub,
    subscription.sourceAppNpub,
    agent.agentId,
    documentId,
  ].join('+');
}

function buildSessionName(agent: AgentDefinitionRecord, documentId: string): string {
  return `${agent.label || agent.agentId} Comment ${documentId}`.slice(0, 120);
}

function buildSessionOrigin(documentKey: string): SessionOrigin {
  return {
    type: 'agent-comment',
    id: documentKey,
    label: `comment:${documentKey.slice(0, 48)}`,
  };
}

function buildMetadata(documentKey: string, input: {
  subscription: WorkspaceSubscriptionRecord;
  agent: AgentDefinitionRecord;
  comment: InboundCommentRecord;
  documentId: string;
}): SessionMetadataInput {
  const route = buildDocumentCommentRoute(input.documentId, input.comment.commentId);
  return {
    AGENT: true,
    role: 'agent-chat',
    routedBy: 'agent-comment',
    agentChatAgentId: input.agent.agentId,
    agentChatBotNpub: input.agent.botNpub,
    bindingType: 'thread',
    bindingId: documentKey,
    goal: `Review document comment ${input.comment.commentId} on document ${input.documentId} and answer in the thread.`,
    nextAction: 'reflect',
    nextActionPayload: route,
    createdByNpub: input.subscription.managedByNpub ?? undefined,
    lastManagedByNpub: input.subscription.managedByNpub ?? undefined,
    chargeToNpub: input.subscription.managedByNpub ?? undefined,
  };
}

function getDocumentIdFromMetadata(session: SessionSnapshot): string | null {
  const payload = compactText(session.metadata?.nextActionPayload);
  if (!payload) {
    return null;
  }
  try {
    const params = new URLSearchParams(payload.includes('?') ? payload.split('?')[1] : payload);
    return compactText(params.get('docid'));
  } catch {
    return null;
  }
}

function isDocumentCommentSession(params: {
  session: SessionSnapshot;
  documentKey: string;
  agentId: string;
  documentId: string;
}): boolean {
  const metadata = params.session.metadata;
  if (metadata?.routedBy !== 'agent-comment') {
    return false;
  }
  if (metadata?.agentChatAgentId !== params.agentId) {
    return false;
  }
  if (params.session.origin?.id === params.documentKey || metadata?.bindingId === params.documentKey) {
    return true;
  }
  if (getDocumentIdFromMetadata(params.session) === params.documentId) {
    return true;
  }
  return params.session.name.includes(` Comment ${params.documentId}`);
}

export interface AgentCommentSessionRuntimeDependencies {
  defaultAgent: AgentType;
  getSession: (sessionId: string) => SessionSnapshot | null;
  listSessions: () => SessionSnapshot[];
  createSession: (
    agent: AgentType,
    workingDirectory: string,
    name: string,
    origin: SessionOrigin,
    explicitNpub?: string,
    metadata?: SessionMetadataInput,
  ) => Promise<SessionSnapshot>;
  updateSessionMetadata: (sessionId: string, metadata: SessionMetadataInput) => SessionSnapshot | null;
  addPrompt: (sessionId: string, content: string) => unknown;
  hasQueuedPrompt?: (sessionId: string, content: string) => boolean;
  maybeAutoDispatchQueuedPrompt: (session: SessionSnapshot | null) => void | Promise<void>;
  prepareWorkspaceYokeRuntime?: (params: {
    sessionId: string;
    workingDirectory: string;
    subscription: WorkspaceSubscriptionRecord;
    botIdentity: RuntimeBotIdentity;
  }) => Promise<AgentWorkspaceYokeRuntime>;
}

export interface AgentDocumentCommentDispatchInput {
  subscription: WorkspaceSubscriptionRecord;
  agent: AgentDefinitionRecord;
  recordId: string;
  comment: InboundCommentRecord;
  botIdentity: RuntimeBotIdentity;
  runtimeContext?: string | null;
}

export class AgentCommentSessionRuntime {
  private readonly defaultAgent: AgentType;
  private readonly getSession: AgentCommentSessionRuntimeDependencies['getSession'];
  private readonly listSessions: AgentCommentSessionRuntimeDependencies['listSessions'];
  private readonly createSession: AgentCommentSessionRuntimeDependencies['createSession'];
  private readonly updateSessionMetadata: AgentCommentSessionRuntimeDependencies['updateSessionMetadata'];
  private readonly addPrompt: AgentCommentSessionRuntimeDependencies['addPrompt'];
  private readonly hasQueuedPrompt: AgentCommentSessionRuntimeDependencies['hasQueuedPrompt'];
  private readonly maybeAutoDispatchQueuedPrompt: AgentCommentSessionRuntimeDependencies['maybeAutoDispatchQueuedPrompt'];
  private readonly prepareWorkspaceYokeRuntime: NonNullable<AgentCommentSessionRuntimeDependencies['prepareWorkspaceYokeRuntime']>;

  constructor(deps: AgentCommentSessionRuntimeDependencies) {
    this.defaultAgent = deps.defaultAgent;
    this.getSession = deps.getSession;
    this.listSessions = deps.listSessions;
    this.createSession = deps.createSession;
    this.updateSessionMetadata = deps.updateSessionMetadata;
    this.addPrompt = deps.addPrompt;
    this.hasQueuedPrompt = deps.hasQueuedPrompt;
    this.maybeAutoDispatchQueuedPrompt = deps.maybeAutoDispatchQueuedPrompt;
    this.prepareWorkspaceYokeRuntime = deps.prepareWorkspaceYokeRuntime ?? prepareAgentWorkspaceYokeRuntime;
  }

  async handleDocumentCommentDispatch(input: AgentDocumentCommentDispatchInput): Promise<SessionSnapshot | null> {
    const documentId = compactText(input.comment.targetRecordId);
    if (!documentId) {
      return null;
    }

    const documentKey = buildDocumentCommentKey(input.subscription, input.agent, documentId);
    const reusable = this.resolveReusableSession(documentKey, input.agent.agentId, documentId);
    if (reusable === 'stopped') {
      return null;
    }
    const session = reusable ?? await this.createSession(
      this.defaultAgent,
      input.agent.workingDirectory,
      buildSessionName(input.agent, documentId),
      buildSessionOrigin(documentKey),
      input.subscription.managedByNpub ?? undefined,
      buildMetadata(documentKey, {
        subscription: input.subscription,
        agent: input.agent,
        comment: input.comment,
        documentId,
      }),
    );

    const liveSession = this.updateSessionMetadata(
      session.id,
      buildMetadata(documentKey, {
        subscription: input.subscription,
        agent: input.agent,
        comment: input.comment,
        documentId,
      }),
    ) ?? session;

    const yokeRuntime = await this.prepareWorkspaceYokeRuntime({
      sessionId: liveSession.id,
      workingDirectory: liveSession.workingDirectory,
      subscription: input.subscription,
      botIdentity: input.botIdentity,
    });
    const prompt = buildDocumentCommentDispatchPrompt({
      agent: input.agent,
      comment: input.comment,
      documentId,
      documentRoute: buildDocumentCommentRoute(documentId, input.comment.commentId),
      commands: buildAgentDocumentCommentYokeCommands(
        yokeRuntime.stateDir,
        documentId,
        input.comment.commentId,
      ),
      runtimeContext: input.runtimeContext,
    });

    if (!this.hasQueuedPrompt?.(liveSession.id, prompt)) {
      this.addPrompt(liveSession.id, prompt);
    }
    await this.maybeAutoDispatchQueuedPrompt(this.getSession(liveSession.id) ?? liveSession);
    return this.getSession(liveSession.id) ?? liveSession;
  }

  private resolveReusableSession(
    documentKey: string,
    agentId: string,
    documentId: string,
  ): SessionSnapshot | 'stopped' | null {
    let sawStoppedSession = false;
    for (const session of this.listSessions()) {
      if (!isDocumentCommentSession({ session, documentKey, agentId, documentId })) {
        continue;
      }
      if (isLiveSession(session)) {
        return session;
      }
      if (isStoppedSession(session)) {
        sawStoppedSession = true;
      }
    }
    return sawStoppedSession ? 'stopped' : null;
  }
}
