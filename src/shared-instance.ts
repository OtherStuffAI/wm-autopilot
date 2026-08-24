type EnvLike = Record<string, string | undefined>;

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function readBooleanEnv(value: string | undefined): boolean | null {
  const normalised = value?.trim().toLowerCase() ?? '';
  if (TRUE_VALUES.has(normalised)) {
    return true;
  }
  if (FALSE_VALUES.has(normalised)) {
    return false;
  }
  return null;
}

export function isSharedInstanceAccessEnabled(env: EnvLike = Bun.env): boolean {
  return readBooleanEnv(env.WINGMAN_SHARED_INSTANCE) === true;
}

export function isSharedAgentDispatchEnabled(env: EnvLike = Bun.env): boolean {
  return readBooleanEnv(env.WINGMAN_SHARED_AGENT_DISPATCH)
    ?? readBooleanEnv(env.WINGMAN_SEE_AGENT_SUBS)
    ?? isSharedInstanceAccessEnabled(env);
}

export function isAgentDispatchAdminOnlyEnabled(env: EnvLike = Bun.env): boolean {
  return readBooleanEnv(env.WINGMAN_AGENT_DISPATCH_ADMIN_ONLY) === true;
}
