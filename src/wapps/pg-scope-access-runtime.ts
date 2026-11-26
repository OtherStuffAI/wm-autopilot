import { createProfileBotIdentityRunner } from "../agent-chat/profile-bot-identity";
import type { AgentDefinitionRecord } from "../agent-chat/types";
import { PgWappScopeAccessResolver, type PgScopeAccessDependencies } from "./pg-scope-access";

export function createPgWappScopeAccessResolver(input: {
  connections: PgScopeAccessDependencies["connections"];
  createClient?: PgScopeAccessDependencies["createClient"];
  agents: { getByBotNpub(npub: string): AgentDefinitionRecord | null };
  identity: Parameters<typeof createProfileBotIdentityRunner>[0];
}) {
  const withProfileIdentity = createProfileBotIdentityRunner(input.identity);
  return new PgWappScopeAccessResolver({
    connections: input.connections,
    createClient: input.createClient,
    withIdentity: async (actorNpub, managerNpub, operation) => {
      if (actorNpub === managerNpub) {
        throw new Error("Human WApp registration requires an explicit downstream PG signing capability; the owner request cannot be re-signed by an agent or service");
      }
      const agent = input.agents.getByBotNpub(actorNpub);
      if (!agent || !agent.enabled || agent.managedByNpub !== managerNpub) {
        throw new Error("Requesting agent has no enabled owner-managed signing profile for PG scope access");
      }
      return withProfileIdentity(agent, operation);
    },
  });
}
