import type { WorkspaceSubscriptionManager } from './subscription-runtime';

type BootstrapManager = Pick<
  WorkspaceSubscriptionManager,
  | 'createAgentProfileForManager'
  | 'getDefaultAgentForManager'
  | 'listAgentsForManager'
  | 'setDefaultAgentForManager'
>;

type CreatedAgentProfile = Awaited<ReturnType<BootstrapManager['createAgentProfileForManager']>>;

export interface DefaultAgentProfileBootstrapResult {
  status: 'already_configured' | 'default_repaired' | 'created';
  profileId: string;
  publicationWarning: string | null;
}

function normaliseProfileId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'wingman';
}

function chooseProfileId(
  instanceName: string,
  managerNpub: string,
  profileIdExists: (profileId: string) => boolean,
): string {
  const base = normaliseProfileId(instanceName);
  if (!profileIdExists(base)) return base;
  const managerSuffix = normaliseProfileId(managerNpub.slice(-8));
  const scoped = `${base}-${managerSuffix}`.slice(0, 73);
  if (!profileIdExists(scoped)) return scoped;
  for (let index = 2; index <= 100; index += 1) {
    const candidate = `${scoped}-${index}`.slice(0, 80);
    if (!profileIdExists(candidate)) return candidate;
  }
  throw new Error('Unable to allocate a default agent profile id.');
}

export async function ensureDefaultAgentProfileForManager(input: {
  manager: BootstrapManager;
  managerNpub: string;
  instanceName: string;
  workingDirectory: string;
  harness: string;
  profileIdExists: (profileId: string) => boolean;
  publishProfile: (created: CreatedAgentProfile) => Promise<unknown>;
}): Promise<DefaultAgentProfileBootstrapResult> {
  const configured = input.manager.getDefaultAgentForManager(input.managerNpub);
  if (configured) {
    return { status: 'already_configured', profileId: configured.agentId, publicationWarning: null };
  }

  const active = input.manager.listAgentsForManager(input.managerNpub)
    .filter((profile) => profile.enabled && profile.archived !== true)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.agentId.localeCompare(right.agentId));
  if (active[0]) {
    const repaired = input.manager.setDefaultAgentForManager(active[0].agentId, input.managerNpub);
    return { status: 'default_repaired', profileId: repaired.agentId, publicationWarning: null };
  }

  const label = input.instanceName.trim() || 'Wingman';
  const profileId = chooseProfileId(label, input.managerNpub, input.profileIdExists);
  const created = await input.manager.createAgentProfileForManager({
    managedByNpub: input.managerNpub,
    agentId: profileId,
    label,
    workspaceOwnerNpub: input.managerNpub,
    workingDirectory: input.workingDirectory,
    harness: input.harness,
    model: null,
    publicProfile: { name: label, picture: null, about: null, nip05: null },
    capabilities: ['chat_intercept', 'task_dispatch', 'comment_dispatch'],
    directChat: {
      enabled: true,
      sessionAgent: input.harness,
      directory: input.workingDirectory,
      model: null,
      idleRetentionMinutes: 60,
    },
    enabled: true,
  });

  let publicationWarning: string | null = null;
  try {
    await input.publishProfile(created);
  } catch (error) {
    publicationWarning = error instanceof Error ? error.message : String(error);
  }
  return { status: 'created', profileId: created.agent.agentId, publicationWarning };
}
