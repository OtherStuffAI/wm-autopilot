import { normaliseBackendBaseUrl } from './tower-client';

export const PG_WORKSPACE_DESCRIPTOR_TYPE = 'wingman_workspace_locator';

export interface PgWorkspaceDescriptor {
  towerBaseUrl: string;
  towerServiceNpub: string;
  workspaceServiceNpub: string;
  workspaceOwnerNpub: string;
  workspaceId: string;
  appNpub: string | null;
  label: string | null;
  capabilities: unknown;
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function findCredentialField(value: unknown, path: string[] = []): string | null {
  const object = getObject(value);
  if (!object) return null;
  for (const [key, child] of Object.entries(object)) {
    const nextPath = [...path, key];
    const normalized = key.toLowerCase();
    if (
      normalized.includes('password')
      || normalized.includes('credential')
      || normalized.includes('private_key')
      || normalized === 'nsec'
      || normalized === 'secret'
      || normalized === 'bearer'
      || normalized === 'token'
      || normalized.endsWith('_token')
      || normalized.includes('access_token')
    ) {
      return nextPath.join('.');
    }
    const nested = findCredentialField(child, nextPath);
    if (nested) return nested;
  }
  return null;
}

export function parsePgWorkspaceDescriptor(input: unknown): PgWorkspaceDescriptor {
  const wrapper = getObject(input);
  const descriptor = wrapper?.type === PG_WORKSPACE_DESCRIPTOR_TYPE
    ? wrapper
    : getObject(wrapper?.descriptor);
  if (!descriptor || descriptor.type !== PG_WORKSPACE_DESCRIPTOR_TYPE) {
    throw new Error('Workspace descriptor must have type wingman_workspace_locator.');
  }
  const credentialField = findCredentialField(descriptor);
  if (credentialField) {
    throw new Error(`Workspace descriptor must not include credential field ${credentialField}.`);
  }
  const identity = getObject(descriptor.identity);
  if (!identity) throw new Error('Workspace descriptor must include a valid identity object.');

  const towerBaseUrl = getString(descriptor.tower_base_url) ?? getString(descriptor.towerBaseUrl);
  const towerServiceNpub = getString(identity.tower_service_npub) ?? getString(identity.towerServiceNpub);
  const workspaceServiceNpub = getString(identity.workspace_service_npub) ?? getString(identity.workspaceServiceNpub);
  const workspaceOwnerNpub = getString(identity.workspace_owner_npub) ?? getString(identity.workspaceOwnerNpub);
  const workspaceId = getString(identity.workspace_id) ?? getString(identity.workspaceId);
  const appNpub = getString(identity.app_npub) ?? getString(identity.appNpub);
  if (!towerBaseUrl) throw new Error('Workspace descriptor must include tower_base_url.');
  if (!towerServiceNpub) throw new Error('Workspace descriptor must include identity.tower_service_npub.');
  if (!workspaceServiceNpub) throw new Error('Workspace descriptor must include identity.workspace_service_npub.');
  if (!workspaceOwnerNpub) throw new Error('Workspace descriptor must include identity.workspace_owner_npub.');
  if (!workspaceId) throw new Error('Workspace descriptor must include identity.workspace_id.');

  return {
    towerBaseUrl: normaliseBackendBaseUrl(towerBaseUrl),
    towerServiceNpub,
    workspaceServiceNpub,
    workspaceOwnerNpub,
    workspaceId,
    appNpub,
    label: getString(descriptor.label) ?? getString(descriptor.name),
    capabilities: descriptor.capabilities,
  };
}
