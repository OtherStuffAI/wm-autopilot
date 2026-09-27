import { createHash } from "node:crypto";
import type { JsonObject } from "./pipeline-store";

const corpus = "learning.space.research.v1";
const primaryHosts = new Set(["science.nasa.gov", "www.nasa.gov", "www.esa.int", "www.jpl.nasa.gov", "solarsystem.nasa.gov"]);
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const rows = (value: unknown) => Array.isArray(value) ? value as Record<string, unknown>[] : [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

export function selectSpaceResearchTopics(input: JsonObject): JsonObject {
  const version = clean(input.graphVersion);
  if (!version) throw new Error("graphVersion is required from the published graph");
  const topics = rows(input.topics).map(row => ({ id: clean(row.id), title: clean(row.title) }));
  if (!topics.length || topics.length > 2 || new Set(topics.map(topic => topic.id)).size !== topics.length || topics.some(topic => !idPattern.test(topic.id) || !topic.title)) {
    throw new Error("Provide one or two published subject IDs and titles");
  }
  return { corpus, graphVersion: version, topics, maxDepth: 1, maxConcepts: 3, maxSources: 3 };
}

export function validateSpaceSourcePlan(input: JsonObject): JsonObject {
  const selection = input.selection as JsonObject;
  if (!selection || selection.corpus !== corpus) throw new Error("Missing bounded subject selection");
  const plan = input.plan as JsonObject;
  const concepts = rows(plan?.concepts);
  const sources = rows(plan?.sources);
  if (!concepts.length || concepts.length > 3 || !sources.length || sources.length > 3) throw new Error("Research fanout exceeds bounds or is empty");
  const selected = new Set(rows(selection.topics).map(row => clean(row.id)));
  const existing = new Set(Array.isArray(input.existingConceptIds) ? input.existingConceptIds.map(clean) : []);
  const ids = new Set<string>();
  for (const concept of concepts) {
    const id = clean(concept.id);
    if (!idPattern.test(id) || ids.has(id) || existing.has(id) || !clean(concept.title) || !selected.has(clean(concept.subjectId))) throw new Error("Invalid supporting concept proposal");
    ids.add(id);
  }
  const urls = new Set<string>();
  for (const source of sources) {
    const url = clean(source.url);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error(`Invalid source URL: ${url}`); }
    if (parsed.protocol !== "https:" || !primaryHosts.has(parsed.hostname) || parsed.username || parsed.password || urls.has(parsed.href)) throw new Error(`Source must be a distinct allowlisted primary URL: ${url}`);
    urls.add(parsed.href);
  }
  return { concepts, sourceUrls: [...urls], graphVersion: selection.graphVersion, topics: selection.topics };
}

function pageText(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&(?:nbsp|amp|quot|#39);/g, " ").replace(/\s+/g, " ").trim();
}

export async function retrieveSpacePrimarySources(input: JsonObject): Promise<JsonObject> {
  const plan = input.plan as JsonObject;
  const urls = Array.isArray(plan?.sourceUrls) ? plan.sourceUrls.map(clean) : [];
  if (!urls.length || urls.length > 3) throw new Error("Source plan required");
  const documents = [];
  for (const url of urls) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !primaryHosts.has(parsed.hostname)) throw new Error("Untrusted primary source URL");
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "error", headers: { accept: "text/html, text/plain" } });
    if (!response.ok) throw new Error(`Primary source retrieval failed: HTTP ${response.status}`);
    if (!/^(text\/html|text\/plain)/i.test(response.headers.get("content-type") ?? "")) throw new Error("Primary source has unsupported content type");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Primary source response has no body");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (bytes < 250_000) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value.slice(0, 250_000 - bytes);
      chunks.push(chunk);
      bytes += chunk.byteLength;
    }
    await reader.cancel();
    const html = new TextDecoder().decode(Buffer.concat(chunks));
    const text = pageText(html).slice(0, 25_000);
    if (text.length < 100) throw new Error("Primary source content is too short");
    documents.push({ url, text, retrievedAt: new Date().toISOString().slice(0, 10) });
  }
  return { documents, sourceSummaries: documents.map(document => ({ url: document.url, retrievedAt: document.retrievedAt, characters: document.text.length })) };
}

function pathExists(edges: { from: string; to: string }[], from: string, to: string): boolean {
  const stack = [from], seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...edges.filter(edge => edge.from === current).map(edge => edge.to));
  }
  return false;
}

export function normalizeSpaceResearchCandidate(input: JsonObject): JsonObject {
  const selection = input.selection as JsonObject;
  const plan = input.plan as JsonObject;
  const draft = input.draft as JsonObject;
  const documents = rows((input.retrieval as JsonObject)?.documents);
  if (!selection || selection.corpus !== corpus || !plan || !draft || !documents.length) throw new Error("Research selection, plan, retrieval and draft are required");
  const sourceByUrl = new Map(documents.map(document => [clean(document.url), document]));
  const sourceRows = rows(draft.sources);
  const conceptRows = rows(draft.concepts);
  const relationRows = rows(draft.relations);
  const supportRows = rows(draft.supports);
  if (!sourceRows.length || sourceRows.length > 3 || !conceptRows.length || conceptRows.length > 3 || relationRows.length > 6 || supportRows.length > 12) throw new Error("Candidate is empty or exceeds bounds");
  const sources = sourceRows.map(row => {
    const url = clean(row.url), document = sourceByUrl.get(url);
    if (!document || !clean(row.title) || !clean(row.publisher)) throw new Error(`Source was not retrieved: ${url}`);
    return { id: `source-${hash(url)}`, url, title: clean(row.title), publisher: clean(row.publisher), retrievedAt: clean(document.retrievedAt), reviewedAt: clean(document.retrievedAt) };
  });
  if (new Set(sources.map(row => row.url)).size !== sources.length) throw new Error("Duplicate source URL");
  const proposed = new Map(rows(plan.concepts).map(row => [clean(row.id), row]));
  const concepts = conceptRows.map(row => {
    const id = clean(row.id);
    if (!proposed.has(id) || !clean(row.title) || !clean(row.claim) || !idPattern.test(clean(row.cluster))) throw new Error(`Unplanned or incomplete concept: ${id}`);
    return { id, cluster: clean(row.cluster), title: clean(row.title), claim: clean(row.claim) };
  });
  if (new Set(concepts.map(row => row.id)).size !== concepts.length) throw new Error("Duplicate concept ID");
  const known = new Set([...rows(selection.topics).map(row => clean(row.id)), ...concepts.map(row => row.id)]);
  const relations = relationRows.map(row => {
    const from = clean(row.from), to = clean(row.to), type = clean(row.type);
    if (!known.has(from) || !known.has(to) || from === to || !["prerequisite", "supports", "explains", "related"].includes(type)) throw new Error("Invalid relation proposal");
    return { id: `${from}--${to}--${type}`, from, to, type };
  });
  if (new Set(relations.map(row => row.id)).size !== relations.length) throw new Error("Duplicate relation ID");
  const sourceIds = new Set(sources.map(row => row.id));
  const conceptIds = new Set(concepts.map(row => row.id));
  const relationIds = new Set(relations.map(row => row.id));
  const supports = supportRows.map(row => {
    const targetType = clean(row.targetType), targetId = clean(row.targetId), source = sources.find(item => item.url === clean(row.sourceUrl));
    const locator = clean(row.locator), excerpt = clean(row.excerpt), summary = clean(row.summary);
    const document = sourceByUrl.get(source?.url ?? "");
    const sourceText = clean(document?.text).toLowerCase();
    if (!source || !sourceIds.has(source.id) || !(targetType === "concept" ? conceptIds : targetType === "relation" ? relationIds : new Set()).has(targetId) || !locator || !sourceText.includes(locator.toLowerCase()) || excerpt.length < 20 || !summary || !sourceText.includes(excerpt.replace(/\s+/g, " ").toLowerCase())) throw new Error(`Unsupported citation: ${targetType}:${targetId}`);
    return { targetType, targetId, sourceId: source.id, locator, summary, excerpt };
  });
  if (new Set(supports.map(row => `${row.targetType}:${row.targetId}:${row.sourceId}`)).size !== supports.length) throw new Error("Duplicate source support");
  for (const id of conceptIds) if (!supports.some(row => row.targetType === "concept" && row.targetId === id)) throw new Error(`Unsupported concept: ${id}`);
  for (const id of relationIds) if (!supports.some(row => row.targetType === "relation" && row.targetId === id)) throw new Error(`Unsupported relation: ${id}`);
  const existing = rows(input.existingPrerequisites).map(row => ({ from: clean(row.from), to: clean(row.to) }));
  const accepted = [...existing];
  for (const relation of relations.filter(row => row.type === "prerequisite")) {
    if (pathExists(accepted, relation.to, relation.from)) throw new Error("Cyclic prerequisite proposal");
    accepted.push(relation);
  }
  const graphVersion = clean(selection.graphVersion);
  const subjectIds = rows(selection.topics).map(row => clean(row.id)).sort();
  const candidateKey = `space-research:${hash(`${corpus}:${graphVersion}:${subjectIds.join(",")}:${sources.map(row => row.url).sort().join(",")}`)}`;
  return { corpus, baseVersion: graphVersion, idempotencyKey: candidateKey, graph: { sources, concepts, relations, supports }, reviewStatus: "candidate", requiresCuratorReview: true };
}

export function spaceResearchReviewGate(input: JsonObject): JsonObject {
  const staged = input.staged as JsonObject;
  if (!staged || staged.reviewStatus !== "staged" || !clean(staged.candidateId)) throw new Error("Candidate staging did not return a reviewable ID");
  return { candidateId: staged.candidateId, reviewStatus: "awaiting_independent_curator_review", published: false };
}
