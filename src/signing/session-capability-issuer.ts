import type { SessionSnapshot } from "../agents/process-manager";
import {
  buildSessionCapabilityProfileContext,
  resolveAndBindSessionCapabilityBotRecord,
  resolveSessionCapabilityProfileScope,
} from "../agents/session-capability-binding";
import type { SessionCapabilityBotRecord } from "../agents/session-capability-identity";
import { CapabilityBroker, buildDefaultAgentCapabilityPolicy, type WalletConstraint, type IssuedSessionCapability } from "./capability-broker";
import type { AgentSigningMode } from "./agent-signing-policy";
import type { SigningPolicyRegistry } from "./signing-policy-registry";

interface ProfileSource {
  agentId: string;
  botNpub: string;
  enabled: boolean;
  archived?: boolean;
}

interface BindingManager {
  getSession(sessionId: string): SessionSnapshot | undefined;
  bindSessionCapabilityIdentity(sessionId: string, botNpub: string, profileId: string): SessionSnapshot | null;
}

export interface SessionCapabilityIssuerDependencies {
  broker: CapabilityBroker;
  getWalletPolicy?: (botNpub: string) => WalletConstraint | undefined;
  registry: SigningPolicyRegistry;
  getManager: () => BindingManager;
  sharedAgentDispatch: boolean;
  adminNpub: string | null;
  towerUrl: string;
  autopilotUrl: string;
  getSigningMode: () => AgentSigningMode;
  listProfiles: (managerNpub: string) => ProfileSource[];
  getDefaultProfile: (managerNpub: string) => ProfileSource | null;
  getActiveByBotNpub: (botNpub: string, profileManagerNpub: string) => SessionCapabilityBotRecord | null;
  ensureProvisioned: (record: SessionCapabilityBotRecord) => void;
  listTowerUrls: (managerNpub: string) => string[];
}

export interface SessionCapabilityIssueInput {
  sessionId: string;
  ownerNpub: string;
  profileId?: string | null;
  botNpub?: string | null;
}

export class SessionCapabilityIssuer {
  constructor(private readonly deps: SessionCapabilityIssuerDependencies) {}

  issue(input: SessionCapabilityIssueInput): IssuedSessionCapability {
    const manager = this.deps.getManager();
    const session = manager.getSession(input.sessionId);
    const profileScope = resolveSessionCapabilityProfileScope({
      ownerNpub: input.ownerNpub,
      sharedAgentDispatch: this.deps.sharedAgentDispatch,
      adminNpub: this.deps.adminNpub,
      metadata: session?.metadata,
    });
    const { profileManagerNpub } = profileScope;
    const profileContext = buildSessionCapabilityProfileContext(
      this.deps.listProfiles(profileManagerNpub),
      this.deps.getDefaultProfile(profileManagerNpub),
    );
    const { record, profileId, session: boundSession } = resolveAndBindSessionCapabilityBotRecord({
      manager,
      sessionId: input.sessionId,
      ownerNpub: input.ownerNpub,
      profileManagerNpub,
      requestedProfileId: input.profileId,
      requestedBotNpub: input.botNpub,
      allowDefaultFallbackForMissingRequestedProfile: profileScope.allowDefaultFallbackForMissingRequestedProfile,
      ...profileContext,
      getActiveByBotNpub: (botNpub) => this.deps.getActiveByBotNpub(botNpub, profileManagerNpub),
    });
    this.deps.ensureProvisioned(record);
    const workspaceId = typeof boundSession.metadata?.flightdeckWorkspaceId === "string"
      ? boundSession.metadata.flightdeckWorkspaceId.trim() || null
      : null;
    const baseline = buildDefaultAgentCapabilityPolicy({
      towerUrl: this.deps.towerUrl,
      towerUrls: this.deps.listTowerUrls(profileManagerNpub),
      autopilotUrl: this.deps.autopilotUrl,
      ownerNpub: input.ownerNpub,
      workspaceId,
      mode: this.deps.getSigningMode(),
    });
    const resolved = this.deps.registry.resolve({ profileId, workspaceId }, baseline);
    // Dedicated project builders have no authority over Tower records, wallets,
    // other sessions or arbitrary signing. Their installed tools run in custody.
    const projectTools=boundSession.metadata?.role === 'completed-turn' && boundSession.metadata?.nativeProjectTools===true;
    if (projectTools) {
      resolved.policy = {operations:['identity.read','capability.refresh'],maxCallsPerMinute:60};
      resolved.policyRefs = [];
    }
    const wallet = projectTools ? undefined : this.deps.getWalletPolicy?.(record.botNpub);
    if (wallet) {
      resolved.policy.wallet = wallet;
      if (wallet.readMethods.length) resolved.policy.operations.push("wallet.read");
      if (wallet.spendMethods.length) resolved.policy.operations.push("wallet.spend");
    }
    return this.deps.broker.issueSessionCapability({
      sessionId: input.sessionId,
      ownerNpub: input.ownerNpub,
      identityManagerNpub: profileManagerNpub,
      profileId,
      workspaceId,
      botNpub: record.botNpub,
      policy: resolved.policy,
      policyRefs: resolved.policyRefs,
    });
  }

  reissue(sessionId: string): IssuedSessionCapability {
    const session = this.deps.getManager().getSession(sessionId);
    if (!session?.npub || session.status === "stopped" || session.status === "error") {
      throw new Error("Cannot reissue capability for an inactive or ownerless session");
    }
    const metadata = session.metadata as Record<string, unknown> | undefined;
    const profileId = typeof metadata?.agentChatAgentId === "string"
      ? metadata.agentChatAgentId
      : typeof metadata?.agentProfileId === "string" ? metadata.agentProfileId : null;
    const botNpub = typeof metadata?.agentChatBotNpub === "string"
      ? metadata.agentChatBotNpub
      : typeof metadata?.flightdeckAgentNpub === "string" ? metadata.flightdeckAgentNpub : null;
    return this.deps.broker.reissueSessionCapability(sessionId, () => this.issue({
      sessionId,
      ownerNpub: session.npub!,
      profileId,
      botNpub,
    }));
  }
}
