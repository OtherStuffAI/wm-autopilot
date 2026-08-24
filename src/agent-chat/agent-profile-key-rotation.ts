import { randomUUID } from 'node:crypto';

import { Database } from 'bun:sqlite';
import { nip19, verifyEvent } from 'nostr-tools';

import { createBrokeredAgentIdentity } from '../identity/brokered-agent-identity';
import { signBotProfileEvent, type SignedNostrEvent } from '../identity/bot-identity-publisher';
import type { BrokerKeyVaultBackend } from '../signing/broker-key-vault';
import { databaseFile } from '../storage/message-store';
import type { AgentDefinitionRecord, BotKeyStoreRecord } from './types';
import { WorkspaceSubscriptionStore } from './workspace-subscription-store';
import {
  buildTowerAgentRotationRequest,
  postTowerAgentRotation,
  resolveTowerAgentRotationContext,
  signTowerAgentRotationHttpRequest,
  TowerAgentRotationError,
  type TowerAgentRotationRequest,
  type TowerAgentRotationResponse,
} from './tower-agent-identity-rotation';

export type AgentProfileRotationState =
  | 'generation_provisioned'
  | 'profile_published'
  | 'tower_commit_uncertain'
  | 'local_cutover_committed'
  | 'completed'
  | 'failed_before_cutover'
  | 'external_action_required';

export interface AgentProfileRotationResult {
  rotationId: string;
  requestId: string;
  profileId: string;
  oldNpub: string;
  newNpub: string | null;
  startedAt: string;
  completedAt: string | null;
  state: AgentProfileRotationState;
  publication: { status: 'published' | 'failed' | 'not_attempted'; detail?: unknown };
  migrations: Array<{ target: string; status: 'completed' | 'blocked' | 'unsupported'; detail: string }>;
  externalActions: Array<{ system: 'tower-flight-deck'; action: string; reason: string }>;
  warnings: string[];
  revokedCapabilityCount: number;
  oldSessionsNeedReplacement: boolean;
  tower: {
    status: 'not_required' | 'pending' | 'completed' | 'idempotent_replay' | 'failed' | 'uncertain';
    actorId?: string;
    workspaceId?: string;
    subscriptionCount?: number;
    migrationCounts?: Record<string, number>;
    completedAt?: string;
    warnings?: string[];
    errorCode?: string | null;
  };
}

interface RotationDeps {
  botKeyStore: {
    getActiveKeyForBotNpub: (botNpub: string) => BotKeyStoreRecord | null;
    createKey: (input: {
      userNpub: string;
      botPubkeyHex: string;
      botNpub: string;
      displayName: string;
      encryptedToUser: string;
      encryptedEscrow: string;
      escrowUuid: string;
    }) => BotKeyStoreRecord;
    deactivateKey: (id: string) => void;
    deleteKey?: (id: string) => void;
  };
  brokerKeyVault: Pick<BrokerKeyVaultBackend, 'provision' | 'remove' | 'withKey'>;
  revokeCapabilitiesForBotNpub: (botNpub: string) => number;
  publish: (input: { event: SignedNostrEvent; agent: AgentDefinitionRecord }) => Promise<unknown>;
  dbPath?: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

interface RotateInput {
  requestId: string;
  profileId: string;
  managedByNpub: string;
  expectedCurrentNpub: string;
  confirmationProfileId: string;
  confirmationCurrentNpub: string;
}

const activeRotations = new Map<string, Promise<AgentProfileRotationResult>>();

function parseResult(value: string): AgentProfileRotationResult {
  return JSON.parse(value) as AgentProfileRotationResult;
}

export class AgentProfileKeyRotation {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(private readonly deps: RotationDeps) {
    this.db = new Database(deps.dbPath ?? databaseFile);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_profile_key_rotations (
      rotation_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      managed_by_npub TEXT NOT NULL,
      old_npub TEXT NOT NULL,
      new_npub TEXT,
      state TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      tower_request_json TEXT,
      UNIQUE(managed_by_npub, profile_id, request_id)
    )`);
    const columns = this.db.query<{ name: string }, []>('PRAGMA table_info(agent_profile_key_rotations)').all();
    if (!columns.some((column) => column.name === 'tower_request_json')) this.db.exec('ALTER TABLE agent_profile_key_rotations ADD COLUMN tower_request_json TEXT');
    this.now = deps.now ?? (() => new Date());
  }

  rotate(input: RotateInput): Promise<AgentProfileRotationResult> {
    const key = `${input.managedByNpub}\0${input.profileId}`;
    const running = activeRotations.get(key);
    if (running) return running;
    const operation = this.perform(input).finally(() => activeRotations.delete(key));
    activeRotations.set(key, operation);
    return operation;
  }

  private async perform(input: RotateInput): Promise<AgentProfileRotationResult> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId)) throw new Error('A stable rotation requestId is required.');
    if (input.confirmationProfileId !== input.profileId || input.confirmationCurrentNpub !== input.expectedCurrentNpub) {
      throw new Error('Rotation confirmation does not match the selected profile and current npub.');
    }
    const saved = this.db.query<{ result_json: string; tower_request_json: string | null }, [string, string, string]>(
      'SELECT result_json, tower_request_json FROM agent_profile_key_rotations WHERE managed_by_npub = ?1 AND profile_id = ?2 AND request_id = ?3',
    ).get(input.managedByNpub, input.profileId, input.requestId);
    if (saved) {
      const prior = parseResult(saved.result_json);
      if (prior.state === 'tower_commit_uncertain' && saved.tower_request_json) {
        return await this.retryUncertainTowerCommit(input, prior, JSON.parse(saved.tower_request_json) as TowerAgentRotationRequest);
      }
      return prior;
    }

    const agent = this.readAgent(input.profileId, input.managedByNpub);
    if (!agent) throw new Error('Agent profile not found.');
    if (agent.botNpub !== input.expectedCurrentNpub) throw new Error('Agent profile identity changed; refresh Settings and confirm again.');
    const managerSubscriptions = new WorkspaceSubscriptionStore(this.deps.dbPath ?? databaseFile)
      .listForManagerNpub(input.managedByNpub);
    const boundSubscriptionIds = new Set(
      this.db.query<{ subscription_id: string }, [string, string]>(
        'SELECT subscription_id FROM agent_profile_workspaces WHERE profile_id = ?1 AND managed_by_npub = ?2',
      ).all(input.profileId, input.managedByNpub).map((row) => row.subscription_id),
    );
    const subscriptions = managerSubscriptions.filter((subscription) => {
      if (boundSubscriptionIds.size > 0) return boundSubscriptionIds.has(subscription.subscriptionId);
      return subscription.agentProfileId === input.profileId;
    });
    let towerContext;
    try {
      towerContext = resolveTowerAgentRotationContext(subscriptions);
    } catch (error) {
      const blocked = this.baseResult(input, agent.botNpub, 'failed_before_cutover');
      const reason = error instanceof Error ? error.message : String(error);
      blocked.migrations.push({ target: 'tower-flight-deck', status: 'unsupported', detail: reason });
      blocked.tower = { status: 'failed', errorCode: 'unsupported_configuration' };
      blocked.warnings.push('No key was generated and the active profile identity was not changed.');
      blocked.completedAt = this.now().toISOString();
      this.insertResult(blocked, input.managedByNpub);
      return blocked;
    }

    const oldRecord = this.deps.botKeyStore.getActiveKeyForBotNpub(agent.botNpub);
    if (!oldRecord || oldRecord.userNpub !== input.managedByNpub) throw new Error('The current broker identity is unavailable for this manager.');
    let newRecord: BotKeyStoreRecord | null = null;
    let generated: ReturnType<typeof createBrokeredAgentIdentity>;
    try {
      generated = createBrokeredAgentIdentity({
        profile: agent.publicProfile,
        provision: (identity, secretKey) => {
          newRecord = this.deps.botKeyStore.createKey({
            userNpub: input.managedByNpub,
            botPubkeyHex: identity.botPubkeyHex,
            botNpub: identity.botNpub,
            displayName: identity.displayName,
            encryptedToUser: '',
            encryptedEscrow: '',
            escrowUuid: '',
          });
          this.deps.brokerKeyVault.provision(newRecord, secretKey);
        },
      });
    } catch (error) {
      if (newRecord) await this.rollbackNewIdentity(newRecord);
      throw error;
    }
    if (!newRecord || !verifyEvent(generated.signedProfileEvent)) throw new Error('Replacement broker signing validation failed.');
    let result = this.baseResult(input, agent.botNpub, 'generation_provisioned', generated.botNpub);
    if (towerContext) result.tower = { status: 'pending', actorId: towerContext.actorId, workspaceId: towerContext.workspaceId, subscriptionCount: towerContext.subscriptionCount };
    this.insertResult(result, input.managedByNpub);

    let towerRequest: TowerAgentRotationRequest | null = null;
    if (towerContext) {
      const createdAt = Math.floor(this.now().getTime() / 1000);
      towerRequest = await this.deps.brokerKeyVault.withKey(newRecord, (secretKey) => buildTowerAgentRotationRequest({
        context: towerContext!, rotationId: result.rotationId, oldNpub: agent.botNpub, newNpub: generated.botNpub,
        createdAt, expiresAt: createdAt + 600, newSecretKey: secretKey,
      }));
      this.saveTowerRequest(result.rotationId, towerRequest);
    }

    try {
      await this.deps.brokerKeyVault.withKey(newRecord, (secretKey) => {
        const signed = signBotProfileEvent(secretKey, agent.publicProfile?.name || agent.label, agent.publicProfile);
        if (!verifyEvent(signed) || nip19.npubEncode(signed.pubkey) !== generated.botNpub) throw new Error('Replacement identity signing check failed.');
      });
      const publication = await this.deps.publish({ event: generated.signedProfileEvent, agent: { ...agent, botNpub: generated.botNpub } });
      result = { ...result, state: 'profile_published', publication: { status: 'published', detail: publication } };
      this.updateResult(result);
    } catch (error) {
      await this.rollbackNewIdentity(newRecord);
      result = { ...result, state: 'failed_before_cutover', completedAt: this.now().toISOString(), publication: { status: 'failed' }, warnings: [`Replacement profile publication failed: ${error instanceof Error ? error.message : String(error)}`] };
      this.updateResult(result);
      return result;
    }

    let towerCommitted = false;
    if (towerRequest) {
      const towerOutcome = await this.callTower(oldRecord, towerRequest);
      if (towerOutcome instanceof TowerAgentRotationError) {
        if (towerOutcome.kind === 'transport_uncertain') {
          result.state = 'tower_commit_uncertain';
          result.tower = { ...result.tower, status: 'uncertain', errorCode: towerOutcome.code };
          result.warnings.push(`${towerOutcome.message} Retry with the same request ID; the staged identity has been retained.`);
          this.updateResult(result);
          return result;
        }
        await this.rollbackNewIdentity(newRecord);
        result.state = 'failed_before_cutover';
        result.completedAt = this.now().toISOString();
        result.tower = { ...result.tower, status: 'failed', errorCode: towerOutcome.code };
        result.migrations.push({ target: 'tower-flight-deck', status: towerOutcome.code === 'unsupported_records' ? 'unsupported' : 'blocked', detail: towerOutcome.message });
        result.warnings.push('Tower did not commit the rotation; the old identity remains active and the staged identity was removed.');
        this.updateResult(result);
        return result;
      }
      this.recordTowerSuccess(result, towerOutcome);
      towerCommitted = true;
      this.updateResult(result);
    }

    try {
      this.commitLocalCutover(input.profileId, input.managedByNpub, agent.botNpub, generated.botNpub);
      result.state = 'local_cutover_committed';
      result.migrations.push(
        { target: 'agent_definitions', status: 'completed', detail: 'Active profile identity updated.' },
        { target: 'dispatch_routes', status: 'completed', detail: 'Profile dispatch routes updated.' },
        { target: 'profile_policy', status: 'completed', detail: 'Agent profile policy identity updated.' },
        { target: 'workspace_subscriptions', status: 'completed', detail: 'Local Tower subscription routing updated after the atomic Tower commit.' },
        { target: 'scheduled_jobs', status: 'completed', detail: 'Future scheduled sessions updated to request the replacement profile identity.' },
        { target: 'pending_intercepts', status: 'completed', detail: 'Only future, sessionless profile-bound intercepts were updated.' },
      );
      this.updateResult(result);
    } catch (error) {
      if (!towerCommitted) await this.rollbackNewIdentity(newRecord);
      result = {
        ...result,
        state: towerCommitted ? 'external_action_required' : 'failed_before_cutover',
        completedAt: this.now().toISOString(),
        warnings: [`Local cutover failed${towerCommitted ? ' after Tower committed; keep both envelopes and repair local routing' : ''}: ${error instanceof Error ? error.message : String(error)}`],
      };
      this.updateResult(result);
      return result;
    }

    result.revokedCapabilityCount = this.deps.revokeCapabilitiesForBotNpub(agent.botNpub);
    this.deps.botKeyStore.deactivateKey(oldRecord.id);
    try {
      await this.deps.brokerKeyVault.remove(oldRecord);
      result.state = 'completed';
    } catch (error) {
      result.state = 'external_action_required';
      result.warnings.push(`Old key metadata is inactive, but its vault envelope could not be removed: ${error instanceof Error ? error.message : String(error)}`);
    }
    result.completedAt = this.now().toISOString();
    result.oldSessionsNeedReplacement = true;
    result.warnings.push('Sessions bound to the retired npub will fail and must be replaced.');
    this.updateResult(result);
    return result;
  }

  private readAgent(profileId: string, managerNpub: string): AgentDefinitionRecord | null {
    const row = this.db.query<Record<string, unknown>, [string, string]>(
      'SELECT * FROM agent_definitions WHERE agent_id = ?1 AND managed_by_npub = ?2',
    ).get(profileId, managerNpub);
    if (!row) return null;
    const profile = JSON.parse(String(row.public_profile_json ?? '{}')) as AgentDefinitionRecord['publicProfile'];
    return {
      agentId: String(row.agent_id), label: String(row.label), botNpub: String(row.bot_npub),
      workspaceOwnerNpub: String(row.workspace_owner_npub), groupNpubs: [], workingDirectory: String(row.working_directory),
      harness: row.harness ? String(row.harness) : null, model: row.model ? String(row.model) : null,
      archived: Boolean(row.archived), publicProfile: profile, publicProfileRefresh: undefined, capabilities: [], directChat: undefined,
      chatPromptTemplate: '', taskPromptTemplate: '', flowDispatchPromptTemplate: '', taskReviewPromptTemplate: '', approvalDispatchPromptTemplate: '',
      enabled: Boolean(row.enabled), createdAt: String(row.created_at), updatedAt: String(row.updated_at), managedByNpub: String(row.managed_by_npub),
    };
  }

  private commitLocalCutover(profileId: string, managerNpub: string, oldNpub: string, newNpub: string): void {
    this.db.transaction(() => {
      const changed = this.db.query('UPDATE agent_definitions SET bot_npub = ?1, updated_at = ?2 WHERE agent_id = ?3 AND managed_by_npub = ?4 AND bot_npub = ?5')
        .run(newNpub, this.now().toISOString(), profileId, managerNpub, oldNpub);
      if (changed.changes !== 1) throw new Error('Profile identity changed before local cutover.');
      this.db.query('UPDATE agent_dispatch_pipeline_routes SET bot_npub = ?1, updated_at = ?2 WHERE managed_by_npub = ?3 AND bot_npub = ?4')
        .run(newNpub, this.now().toISOString(), managerNpub, oldNpub);
      this.db.query('UPDATE agent_profiles SET agent_npub = ?1, updated_at = ?2 WHERE profile_id = ?3 AND managed_by_npub = ?4 AND agent_npub = ?5')
        .run(newNpub, this.now().toISOString(), profileId, managerNpub, oldNpub);
      this.db.query('UPDATE workspace_subscriptions SET bot_npub = ?1, ws_key_npub = CASE WHEN ws_key_npub = ?2 THEN ?1 ELSE ws_key_npub END, updated_at = ?3 WHERE managed_by_npub = ?4 AND (agent_profile_id = ?5 OR bot_npub = ?2)')
        .run(newNpub, oldNpub, this.now().toISOString(), managerNpub, profileId);
      const scheduledJobsTable = this.db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1").get('scheduled_jobs');
      if (scheduledJobsTable) {
        this.db.query('UPDATE scheduled_jobs SET bot_npub = ?1, updated_at = ?2 WHERE user_npub = ?3 AND bot_npub = ?4')
          .run(newNpub, this.now().toISOString(), managerNpub, oldNpub);
      }
      this.db.query("UPDATE chat_intercept_state SET target_bot_npub = ?1, updated_at = ?2 WHERE agent_id = ?3 AND target_bot_npub = ?4 AND session_id IS NULL AND state IN ('pending', 'idle')")
        .run(newNpub, this.now().toISOString(), profileId, oldNpub);
    })();
  }

  private baseResult(input: RotateInput, oldNpub: string, state: AgentProfileRotationState, newNpub: string | null = null): AgentProfileRotationResult {
    return { rotationId: randomUUID(), requestId: input.requestId, profileId: input.profileId, oldNpub, newNpub, startedAt: this.now().toISOString(), completedAt: null, state, publication: { status: 'not_attempted' }, migrations: [], externalActions: [], warnings: [], revokedCapabilityCount: 0, oldSessionsNeedReplacement: false, tower: { status: 'not_required' } };
  }

  private insertResult(result: AgentProfileRotationResult, managedByNpub: string): void {
    this.db.query('INSERT INTO agent_profile_key_rotations (rotation_id, request_id, profile_id, managed_by_npub, old_npub, new_npub, state, result_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)')
      .run(result.rotationId, result.requestId, result.profileId, managedByNpub, result.oldNpub, result.newNpub, result.state, JSON.stringify(result), result.startedAt, this.now().toISOString());
  }

  private updateResult(result: AgentProfileRotationResult): void {
    this.db.query('UPDATE agent_profile_key_rotations SET new_npub = ?1, state = ?2, result_json = ?3, updated_at = ?4 WHERE rotation_id = ?5')
      .run(result.newNpub, result.state, JSON.stringify(result), this.now().toISOString(), result.rotationId);
  }

  private async rollbackNewIdentity(record: BotKeyStoreRecord): Promise<void> {
    try { await this.deps.brokerKeyVault.remove(record); } finally {
      if (this.deps.botKeyStore.deleteKey) this.deps.botKeyStore.deleteKey(record.id);
      else this.deps.botKeyStore.deactivateKey(record.id);
    }
  }

  private saveTowerRequest(rotationId: string, request: TowerAgentRotationRequest): void {
    this.db.query('UPDATE agent_profile_key_rotations SET tower_request_json = ?1, updated_at = ?2 WHERE rotation_id = ?3')
      .run(JSON.stringify(request), this.now().toISOString(), rotationId);
  }

  private async callTower(oldRecord: BotKeyStoreRecord, request: TowerAgentRotationRequest): Promise<TowerAgentRotationResponse | TowerAgentRotationError> {
    try {
      const authorization = await this.deps.brokerKeyVault.withKey(oldRecord, (secretKey) =>
        signTowerAgentRotationHttpRequest(request, secretKey, Math.floor(this.now().getTime() / 1000)));
      return await postTowerAgentRotation({ request, authorization, fetchImpl: this.deps.fetchImpl });
    } catch (error) {
      return error instanceof TowerAgentRotationError
        ? error
        : new TowerAgentRotationError(error instanceof Error ? error.message : String(error), 'transport_uncertain');
    }
  }

  private recordTowerSuccess(result: AgentProfileRotationResult, response: TowerAgentRotationResponse): void {
    result.tower = {
      ...result.tower,
      status: response.status,
      actorId: response.actor_id,
      migrationCounts: response.migration_counts,
      completedAt: response.completed_at,
      warnings: response.warnings,
    };
    result.migrations.push({
      target: 'tower-flight-deck', status: 'completed',
      detail: `${response.status}; ${Object.entries(response.migration_counts).map(([name, count]) => `${name}: ${count}`).join(', ') || 'no denormalized rows changed'}.`,
    });
    result.warnings.push(...response.warnings);
  }

  private async retryUncertainTowerCommit(input: RotateInput, result: AgentProfileRotationResult, request: TowerAgentRotationRequest): Promise<AgentProfileRotationResult> {
    const oldRecord = this.deps.botKeyStore.getActiveKeyForBotNpub(result.oldNpub);
    const newRecord = result.newNpub ? this.deps.botKeyStore.getActiveKeyForBotNpub(result.newNpub) : null;
    if (!oldRecord || !newRecord || oldRecord.userNpub !== input.managedByNpub || newRecord.userNpub !== input.managedByNpub) {
      throw new Error('Cannot safely retry uncertain Tower rotation because one of the staged vault identities is unavailable.');
    }
    const outcome = await this.callTower(oldRecord, request);
    if (outcome instanceof TowerAgentRotationError) {
      result.warnings.push(`${outcome.message} The staged identity remains available for another idempotent retry.`);
      result.tower = { ...result.tower, status: 'uncertain', errorCode: outcome.code };
      this.updateResult(result);
      return result;
    }
    this.recordTowerSuccess(result, outcome);
    try {
      this.commitLocalCutover(result.profileId, input.managedByNpub, result.oldNpub, result.newNpub!);
    } catch (error) {
      result.state = 'external_action_required';
      result.warnings.push(`Tower committed, but local cutover failed and must be repaired without rolling Tower back: ${error instanceof Error ? error.message : String(error)}`);
      this.updateResult(result);
      return result;
    }
    result.state = 'local_cutover_committed';
    result.revokedCapabilityCount = this.deps.revokeCapabilitiesForBotNpub(result.oldNpub);
    this.deps.botKeyStore.deactivateKey(oldRecord.id);
    try { await this.deps.brokerKeyVault.remove(oldRecord); result.state = 'completed'; }
    catch (error) { result.state = 'external_action_required'; result.warnings.push(`Old key metadata is inactive, but its vault envelope could not be removed: ${error instanceof Error ? error.message : String(error)}`); }
    result.completedAt = this.now().toISOString();
    result.oldSessionsNeedReplacement = true;
    result.warnings.push('Sessions bound to the retired npub will fail and must be replaced.');
    this.updateResult(result);
    return result;
  }
}
