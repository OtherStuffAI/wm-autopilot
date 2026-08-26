import type { AgentProfileMediaStore } from '../agent-chat/agent-profile-media-store';
import type { WorkspaceSubscriptionManager } from '../agent-chat/subscription-runtime';
import type { AgentDefinitionRecord } from '../agent-chat/types';
import type { SignedNostrEvent } from '../identity/bot-identity-publisher';

export interface AgentProfileMediaRequestScope {
  managerNpub: string;
  canManage: boolean;
}

export interface AgentProfileMediaApiContext {
  manager: WorkspaceSubscriptionManager;
  agentTypes?: Array<{ id: string; label: string; modelOptions?: string[] }>;
  publishAgentProfile?: (input: { event: SignedNostrEvent; agent: AgentDefinitionRecord }) => Promise<unknown>;
  republishAgentProfile?: (agent: AgentDefinitionRecord) => Promise<{
    eventId: string;
    createdAt: number;
    [key: string]: unknown;
  }>;
  profileMediaStore?: AgentProfileMediaStore;
  profileMediaBaseUrl?: string;
  profileMediaBaseUrlConfigured?: boolean;
}
