import { isAbsolute } from 'node:path';

import {
  AgentProfileMediaStore,
  AgentProfileMediaValidationError,
  MAX_AGENT_PROFILE_MEDIA_BYTES,
  verifyAgentProfileMedia,
  type AgentProfileMediaOwner,
  type AgentProfileMediaRecord,
  type VerifiedAgentProfileMedia,
} from '../agent-chat/agent-profile-media-store';
import { AgentProfileCreationError } from '../agent-chat/subscription-runtime';
import type { AgentDefinitionRecord } from '../agent-chat/types';
import { buildAgentProfileMediaPublicUrl } from './agent-profile-media-public-route';
import type { AgentProfileMediaApiContext, AgentProfileMediaRequestScope } from './agent-profile-media-route-types';

export type { AgentProfileMediaApiContext, AgentProfileMediaRequestScope } from './agent-profile-media-route-types';

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

type UploadFile = Blob & { name?: string; size: number; type: string };

function serialiseAgent(record: AgentDefinitionRecord) {
  const { groupNpubs: _legacyGroupNpubs, ...visibleRecord } = record;
  return {
    ...visibleRecord,
    operator: {
      enabled: record.enabled,
      capabilityCount: record.capabilities.length,
    },
  };
}

function requireManagement(scope: AgentProfileMediaRequestScope): Response | null {
  return scope.canManage ? null : Response.json({ error: 'Agent profile management requires administrator access.' }, { status: 403 });
}

function readUploadFile(value: unknown): UploadFile | null {
  if (!value || typeof value === 'string' || typeof (value as Blob).arrayBuffer !== 'function') return null;
  return value as UploadFile;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function readMultipart(request: Request): Promise<{ body: Record<string, unknown>; file: UploadFile } | Response> {
  let form: Awaited<ReturnType<Request['formData']>>;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: 'Invalid profile media form data.' }, { status: 400 });
  }
  const file = readUploadFile(form.get('file') ?? form.get('image'));
  if (!file) return Response.json({ error: 'A profile image file is required.' }, { status: 400 });
  const rawProfile = form.get('profile');
  const body = typeof rawProfile === 'string' && rawProfile.trim() ? parseJsonObject(rawProfile) : {};
  if (!body) return Response.json({ error: 'The profile form field must be a JSON object.' }, { status: 400 });
  return { body, file };
}

async function verifyUpload(file: UploadFile): Promise<VerifiedAgentProfileMedia> {
  if (file.size > MAX_AGENT_PROFILE_MEDIA_BYTES) {
    throw new AgentProfileMediaValidationError('Profile image exceeds the 5MB limit.', 413);
  }
  return verifyAgentProfileMedia(new Uint8Array(await file.arrayBuffer()), file.type);
}

function mediaStatus(record: AgentProfileMediaRecord, publicUrl: string, publishedToRelays: boolean) {
  return {
    savedLocally: true,
    publishedToRelays,
    digest: record.digest,
    contentType: record.contentType,
    size: record.size,
    createdAt: record.createdAt,
    publicUrl,
  };
}

function validationResponse(error: unknown, fallback: string): Response {
  const status = error instanceof AgentProfileMediaValidationError ? error.statusCode : 400;
  return Response.json({ error: error instanceof Error ? error.message : fallback }, { status });
}

function resolveMediaDependencies(ctx: AgentProfileMediaApiContext): {
  store: AgentProfileMediaStore;
  baseUrl: string;
  baseUrlConfigured: boolean;
} | Response {
  if (!ctx.profileMediaStore) return Response.json({ error: 'Agent profile media storage is unavailable.' }, { status: 503 });
  return {
    store: ctx.profileMediaStore,
    baseUrl: ctx.profileMediaBaseUrl ?? '',
    baseUrlConfigured: ctx.profileMediaBaseUrlConfigured === true,
  };
}

function buildOwnedPublicUrl(
  deps: { baseUrl: string; baseUrlConfigured: boolean },
  digest: string,
): string {
  return buildAgentProfileMediaPublicUrl({
    baseUrl: deps.baseUrl,
    baseUrlConfigured: deps.baseUrlConfigured,
    digest,
  });
}

async function rollbackCreatedProfile(
  ctx: AgentProfileMediaApiContext,
  agent: AgentDefinitionRecord,
  media: VerifiedAgentProfileMedia | null,
  owner: AgentProfileMediaOwner | null,
): Promise<string[]> {
  const warnings: string[] = [];
  if (media && owner && ctx.profileMediaStore) {
    try {
      ctx.profileMediaStore.release(media, owner);
    } catch (error) {
      warnings.push(`Media cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    await ctx.manager.rollbackCreatedAgentProfile(agent.agentId, agent.botNpub);
  } catch (error) {
    warnings.push(`Agent identity rollback failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return warnings;
}

async function readCreateRequest(request: Request): Promise<{
  body: Record<string, unknown>;
  file: UploadFile | null;
} | Response> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.toLowerCase().startsWith('multipart/form-data')) return readMultipart(request);
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid');
    return { body: body as Record<string, unknown>, file: null };
  } catch {
    return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }
}

export async function handleAgentProfileCreateApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  scope: AgentProfileMediaRequestScope,
  ctx: AgentProfileMediaApiContext,
): Promise<Response | null> {
  if (url.pathname !== '/api/agent-chat/profiles' || method !== 'POST') return null;
  const denied = requireManagement(scope);
  if (denied) return denied;
  if (!ctx.publishAgentProfile) {
    return Response.json({ error: 'Durable agent identity publishing is unavailable' }, { status: 503 });
  }
  const parsed = await readCreateRequest(request);
  if (parsed instanceof Response) return parsed;
  const { body, file } = parsed;
  const profileId = typeof body.profileId === 'string' ? body.profileId.trim() : '';
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const workingDirectory = typeof body.workingDirectory === 'string' ? body.workingDirectory.trim() : '';
  const workspaceOwnerNpub = typeof body.workspaceOwnerNpub === 'string' && body.workspaceOwnerNpub.trim()
    ? body.workspaceOwnerNpub.trim()
    : scope.managerNpub;
  const harness = typeof body.harness === 'string' ? body.harness.trim() : '';
  const requestedModel = typeof body.model === 'string' ? body.model.trim() || null : null;
  const model = requestedModel === 'default' ? null : requestedModel;
  const agentType = ctx.agentTypes?.find((item) => item.id === harness);
  if (!profileId || !label || !workingDirectory || !harness) {
    return Response.json({ error: 'profileId, label, workingDirectory, and harness are required.' }, { status: 400 });
  }
  if (ctx.agentTypes && !agentType) return Response.json({ error: `Unknown agent harness: ${harness}.` }, { status: 400 });
  if (model && agentType && !agentType.modelOptions?.includes(model)) {
    return Response.json({ error: `Model ${model} is not available for ${harness}.` }, { status: 400 });
  }

  let verified: VerifiedAgentProfileMedia | null = null;
  let ownedPublicUrl: string | null = null;
  let mediaDeps: ReturnType<typeof resolveMediaDependencies> | null = null;
  if (file) {
    mediaDeps = resolveMediaDependencies(ctx);
    if (mediaDeps instanceof Response) return mediaDeps;
    try {
      verified = await verifyUpload(file);
      ownedPublicUrl = buildOwnedPublicUrl(mediaDeps, verified.digest);
    } catch (error) {
      return validationResponse(error, 'Failed to validate profile image.');
    }
  }
  const publicProfile = {
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : label,
    picture: ownedPublicUrl ?? (typeof body.picture === 'string' && body.picture.trim() ? body.picture.trim() : null),
    about: typeof body.about === 'string' && body.about.trim() ? body.about.trim() : null,
    nip05: typeof body.nip05 === 'string' && body.nip05.trim() ? body.nip05.trim() : null,
  };

  try {
    const created = await ctx.manager.createAgentProfileForManager({
      managedByNpub: scope.managerNpub,
      agentId: profileId,
      label,
      workspaceOwnerNpub,
      workingDirectory,
      harness,
      model,
      publicProfile,
      capabilities: ['chat_intercept', 'task_dispatch', 'comment_dispatch'],
      directChat: { enabled: true, sessionAgent: harness, directory: workingDirectory, model, idleRetentionMinutes: 60 },
      enabled: body.enabled !== false,
    });
    const owner = verified ? {
      agentId: created.agent.agentId,
      botNpub: created.agent.botNpub,
      managerNpub: scope.managerNpub,
    } : null;
    let stored: AgentProfileMediaRecord | null = null;
    if (verified && owner && mediaDeps && !(mediaDeps instanceof Response)) {
      try {
        stored = mediaDeps.store.put(verified, owner);
      } catch (error) {
        const rollbackWarnings = await rollbackCreatedProfile(ctx, created.agent, verified, owner);
        return Response.json({
          error: error instanceof Error ? error.message : 'Failed to save profile image locally.',
          code: 'agent_profile_media_storage_failed',
          published: false,
          media: { savedLocally: false, publishedToRelays: false },
          rollbackWarnings,
        }, { status: 500 });
      }
    }
    try {
      const publication = await ctx.publishAgentProfile({ event: created.signedProfileEvent, agent: created.agent });
      return Response.json({
        agent: serialiseAgent(created.agent),
        publication,
        media: stored && ownedPublicUrl ? mediaStatus(stored, ownedPublicUrl, true) : null,
      }, { status: 201 });
    } catch (error) {
      const rollbackWarnings = await rollbackCreatedProfile(ctx, created.agent, verified, owner);
      return Response.json({
        error: error instanceof Error ? error.message : 'Agent profile publication failed.',
        code: 'agent_profile_publication_failed',
        published: false,
        media: { savedLocally: false, publishedToRelays: false },
        rollbackWarnings,
      }, { status: 502 });
    }
  } catch (error) {
    const creationError = error instanceof AgentProfileCreationError ? error : null;
    return Response.json({
      error: error instanceof Error ? error.message : 'Failed to create agent profile.',
      code: creationError?.code ?? 'agent_profile_persistence_failed',
    }, { status: creationError?.stage === 'vault' ? 503 : 500 });
  }
}

async function buildMediaCandidate(
  existing: AgentDefinitionRecord,
  body: Record<string, unknown>,
  ownedPublicUrl: string,
  ctx: AgentProfileMediaApiContext,
): Promise<AgentDefinitionRecord> {
  const directChatInput = body.directChat && typeof body.directChat === 'object' && !Array.isArray(body.directChat)
    ? body.directChat as Record<string, unknown>
    : null;
  const workingDirectory = typeof body.workingDirectory === 'string'
    ? body.workingDirectory
    : typeof directChatInput?.directory === 'string' ? directChatInput.directory : existing.workingDirectory;
  const harness = typeof body.harness === 'string'
    ? body.harness.trim()
    : typeof directChatInput?.sessionAgent === 'string' ? directChatInput.sessionAgent.trim() : existing.harness ?? existing.directChat?.sessionAgent ?? '';
  const rawModel = Object.prototype.hasOwnProperty.call(body, 'model') ? body.model : directChatInput?.model;
  const requestedModel = typeof rawModel === 'string' ? rawModel.trim() || null : existing.model ?? null;
  const model = requestedModel === 'default' ? null : requestedModel;
  const agentType = ctx.agentTypes?.find((item) => item.id === harness);
  if (!workingDirectory || !harness) throw new Error('workingDirectory and harness are required.');
  if (!isAbsolute(workingDirectory)) throw new Error('workingDirectory must be an absolute path.');
  await ctx.manager.validateAgentWorkingDirectory?.(workingDirectory);
  if (ctx.agentTypes && !agentType) throw new Error(`Unknown agent harness: ${harness}.`);
  if (model && agentType && !agentType.modelOptions?.includes(model)) throw new Error(`Model ${model} is not available for ${harness}.`);
  const publicInput = body.publicProfile && typeof body.publicProfile === 'object' && !Array.isArray(body.publicProfile)
    ? body.publicProfile as Record<string, unknown>
    : {};
  const label = typeof body.label === 'string' ? body.label.trim() || existing.agentId : existing.label;
  return {
    ...existing,
    label,
    workingDirectory,
    harness,
    model,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : existing.enabled,
    archived: typeof body.archived === 'boolean' ? body.archived : existing.archived,
    publicProfile: {
      name: typeof publicInput.name === 'string' ? publicInput.name.trim() || label : existing.publicProfile?.name || label,
      picture: ownedPublicUrl,
      about: typeof publicInput.about === 'string' ? publicInput.about.trim() || null : existing.publicProfile?.about ?? null,
      nip05: typeof publicInput.nip05 === 'string' ? publicInput.nip05.trim() || null : existing.publicProfile?.nip05 ?? null,
    },
    directChat: {
      enabled: typeof body.directChatEnabled === 'boolean'
        ? body.directChatEnabled
        : directChatInput?.enabled === undefined ? existing.directChat?.enabled !== false : directChatInput.enabled !== false,
      sessionAgent: harness,
      directory: workingDirectory,
      model,
      idleRetentionMinutes: existing.directChat?.idleRetentionMinutes ?? 60,
    },
  };
}

export async function handleAgentProfileMediaUploadApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  scope: AgentProfileMediaRequestScope,
  ctx: AgentProfileMediaApiContext,
): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/agent-chat\/profiles\/([^/]+)\/media$/);
  if (!match || method !== 'POST') return null;
  const denied = requireManagement(scope);
  if (denied) return denied;
  if (!ctx.republishAgentProfile) return Response.json({ error: 'Agent profile publishing is unavailable' }, { status: 503 });
  const agentId = decodeURIComponent(match[1]!);
  const existing = ctx.manager.getAgentForManager(agentId, scope.managerNpub);
  if (!existing) return Response.json({ error: 'Agent profile not found' }, { status: 404 });
  const mediaDeps = resolveMediaDependencies(ctx);
  if (mediaDeps instanceof Response) return mediaDeps;
  const parsed = await readMultipart(request);
  if (parsed instanceof Response) return parsed;

  let verified: VerifiedAgentProfileMedia;
  let publicUrl: string;
  let candidate: AgentDefinitionRecord;
  try {
    verified = await verifyUpload(parsed.file);
    publicUrl = buildOwnedPublicUrl(mediaDeps, verified.digest);
    candidate = await buildMediaCandidate(existing, parsed.body, publicUrl, ctx);
  } catch (error) {
    return validationResponse(error, 'Failed to validate profile image.');
  }
  const owner = { agentId: existing.agentId, botNpub: existing.botNpub, managerNpub: scope.managerNpub };
  let stored: AgentProfileMediaRecord;
  try {
    stored = mediaDeps.store.put(verified, owner);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Failed to save profile image locally.' }, { status: 500 });
  }
  let publication: Awaited<ReturnType<NonNullable<typeof ctx.republishAgentProfile>>>;
  try {
    publication = await ctx.republishAgentProfile(candidate);
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : 'Failed to publish agent profile.',
      code: 'agent_profile_publication_failed',
      published: false,
      media: mediaStatus(stored, publicUrl, false),
    }, { status: 502 });
  }
  candidate.publicProfileRefresh = {
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    sourceEventId: publication.eventId,
    sourceEventCreatedAt: publication.createdAt,
    result: 'published',
    error: null,
  };
  try {
    const agent = await ctx.manager.saveAgentForManager({
      ...candidate,
      managedByNpub: scope.managerNpub,
      unboundProfile: true,
      preserveValidatedWorkingDirectory: true,
    });
    return Response.json({
      agent: serialiseAgent(agent),
      published: true,
      publication,
      media: mediaStatus(stored, publicUrl, true),
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : 'Published profile image but failed to update the local agent profile.',
      code: 'agent_profile_local_update_failed',
      published: true,
      publication,
      media: mediaStatus(stored, publicUrl, true),
    }, { status: 500 });
  }
}
