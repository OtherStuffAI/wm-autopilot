import { generateIdentityAlias } from "../identity/identity-alias.ts";
import { listPipelineDefinitions } from "../pipelines/pipeline-loader.ts";
import { assertEnrichmentDefinition } from "../agent-chat/direct-chat-enrichment-service.ts";

export async function agentDirectEnrichmentOptions(ownerNpub: string) {
  const definitions = await listPipelineDefinitions(generateIdentityAlias(ownerNpub));
  const pipelines = definitions.filter(d => {
    if (d.spec.enabled === false) return false;
    try { assertEnrichmentDefinition(d); return true; } catch { return false; }
  }).map(d => ({ name: d.name, id: d.id, version: d.spec.version, description: d.spec.description }));
  return { supported: true, pipelines, toolMode: "existing-mcp-descriptors", hotLoading: false };
}
