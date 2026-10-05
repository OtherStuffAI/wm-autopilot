import type { MemoryEntity, GraphMemoryMatch } from "./functions.ts";
import type { JsonObject } from "./pipeline-store.ts";

export interface TowerGraphSearchTransport {
  sign: (url: string) => Promise<string>;
  fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
}

// The same operation backs tower.searchGraph and broker-scoped enrichment.
export async function searchTowerGraph(input: JsonObject, transport: TowerGraphSearchTransport,
  helpers: { entities: (value: unknown) => MemoryEntity[];
    baseUrl: (input: JsonObject) => string; url: (base: string, entity: MemoryEntity, input: JsonObject, limit: number) => string;
    results: (payload: unknown, entity: MemoryEntity) => GraphMemoryMatch[]; dedupe: (matches: GraphMemoryMatch[]) => GraphMemoryMatch[] }): Promise<JsonObject> {
  const bounded = (value: unknown, fallback: number, max: number) => {
    const number = Math.floor(Number(value)); return Number.isFinite(number) && number > 0 ? Math.min(number, max) : fallback;
  };
  const entities = helpers.entities(input.entities).slice(0, 8);
  if (!entities.length) return { matches: [], warnings: ["No memory entities were provided for Tower graph search."], graphMemoryAvailable: false };
  const warnings: string[] = [];
  const towerBaseUrl = helpers.baseUrl(input);
  const matches = await Promise.all(entities.map(async entity => {
    const url = helpers.url(towerBaseUrl, entity, input, bounded(input.topKPerEntity, 5, 20));
    try {
      const authorization = await transport.sign(url);
      const response = await transport.fetch(url, { method: "GET", headers: { accept: "application/json", authorization }, signal: transport.signal });
      if (!response.ok) throw new Error(`Tower graph search failed (HTTP ${response.status})`);
      const payload = await response.json() as JsonObject;
      if (!payload || !Array.isArray(payload.results)) throw new Error("Tower graph search returned no results array.");
      return helpers.results(payload, entity);
    } catch (error) {
      warnings.push(`${entity.name}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }));
  return { matches: helpers.dedupe(matches.flat()).slice(0, bounded(input.maxMatches, 20, 40)),
    entities, warnings, graphMemoryAvailable: warnings.length < entities.length, searchedAt: new Date().toISOString(),
    source: "tower-postgres-graph", towerBaseUrl };
}
