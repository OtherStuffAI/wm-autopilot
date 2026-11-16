import type { BotKeyRecord, BotKeyStore } from "../identity/bot-key-store";

export interface SchedulerIdentityBinding {
  userNpub: string;
  botNpub: string;
}

export class SchedulerIdentityError extends Error {}

interface RunProfile {
  agentId: string;
  botNpub: string;
  label: string;
  enabled: boolean;
  archived?: boolean;
}

/** Owner access is authorized by the route; this policy never changes that owner. */
export function createSchedulerRunIdentityPolicy(deps: {
  keys: Pick<BotKeyStore, "getActiveKeyForBotNpub">;
  listProfiles: (ownerNpub: string) => RunProfile[];
  getInstanceNpub: () => string | null;
  isKeyAvailable: (key: BotKeyRecord) => boolean;
}) {
  function resolve(job: SchedulerIdentityBinding) {
    if (!job.botNpub) throw new SchedulerIdentityError("Choose a Run as identity (botNpub is required).");
    const instanceNpub = deps.getInstanceNpub();
    if (!instanceNpub) throw new SchedulerIdentityError("WINGMAN_PRIV is required to execute scheduled jobs.");
    const profile = deps.listProfiles(job.userNpub).find(entry =>
      entry.botNpub === job.botNpub && entry.enabled && !entry.archived);
    if (!profile) throw new SchedulerIdentityError("Run as identity requires an active profile in the scheduler owner space.");
    const key = deps.keys.getActiveKeyForBotNpub(job.botNpub);
    // Match the broker: a registered identity must satisfy its owner binding even
    // if its public key also equals the configured instance identity.
    if (key) {
      if (key.userNpub !== job.userNpub) {
        throw new SchedulerIdentityError("Run as identity is not owned by the scheduler owner.");
      }
      if (!deps.isKeyAvailable(key)) throw new SchedulerIdentityError("Run as identity signing is unavailable; provision its broker vault first.");
    } else if (instanceNpub !== job.botNpub) {
      throw new SchedulerIdentityError("Run as identity is unknown, revoked or unavailable.");
    }
    return { botNpub: job.botNpub, name: profile.label, agentId: profile.agentId };
  }

  return {
    resolve,
    validate: (job: SchedulerIdentityBinding): void => { resolve(job); },
    list: (userNpub: string) => {
      const identities: Array<{ botNpub: string; name: string }> = [];
      for (const profile of deps.listProfiles(userNpub)) {
        if (identities.some(entry => entry.botNpub === profile.botNpub)) continue;
        try {
          const { botNpub, name } = resolve({ userNpub, botNpub: profile.botNpub });
          identities.push({ botNpub, name });
        } catch (error) {
          if (!(error instanceof SchedulerIdentityError)) throw error;
          // Invalid identities are not selectable. Writes and execution surface
          // the specific validation error for an explicitly selected identity.
        }
      }
      return identities;
    },
  };
}
