#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { requestJsonBotCrypto } from "./lib/auth";
import { spaceCandidatePath, stageSpaceCandidate } from "../src/pipelines/space-research-candidate-api";

const path = spaceCandidatePath;
const [command, ...args] = Bun.argv.slice(2);
const option = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const towerUrl = option("--tower-url") ?? Bun.env.PIPELINE_TOWER_URL ?? Bun.env.TOWER_URL;
function requireTowerUrl(): string {
  if (!towerUrl) throw new Error("PIPELINE_TOWER_URL or --tower-url is required");
  return towerUrl;
}
if (!Bun.env.SESSION_ID || !Bun.env.WINGMAN_CAPABILITY) throw new Error("Brokered agent capability is required");
const brokerUrl = Bun.env.WINGMAN_URL;
if (!brokerUrl) throw new Error("WINGMAN_URL capability broker origin is required");

if (command === "run") {
  const ids = (option("--ids") ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!ids.length || ids.length > 2 || ids.some(id => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) throw new Error("run requires one or two subject IDs");
  const result = await requestJsonBotCrypto<Record<string, unknown>>(brokerUrl, "POST", "/api/pipelines/definitions/space-research.v1/runs?async=1", { input: { subjectIds: ids } }, brokerUrl);
  console.log(JSON.stringify({ run: result.run }));
} else if (command === "subjects") {
  const ids = (option("--ids") ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!ids.length || ids.length > 2 || ids.some(id => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) throw new Error("subjects requires one or two IDs");
  const subjectResult = await requestJsonBotCrypto<Record<string, unknown>>(requireTowerUrl(), "GET", "/api/v4/learning/research/subjects", undefined, brokerUrl);
  const all = Array.isArray(subjectResult.concepts) ? subjectResult.concepts as Record<string, unknown>[] : [];
  const topics = ids.map(id => {
    const found = all.find(item => item.id === id);
    if (!found || typeof found.title !== "string") throw new Error(`Published subject not found: ${id}`);
    return { id, title: found.title };
  });
  const existingPrerequisites = new Map<string, { from: string; to: string }>();
  for (const id of ids) {
    const result = await requestJsonBotCrypto<Record<string, unknown>>(requireTowerUrl(), "GET", `/api/v4/learning/research/concepts/${id}/walk?depth=4&limit=100`, undefined, brokerUrl);
    for (const row of Array.isArray(result.relations) ? result.relations as Record<string, unknown>[] : []) {
      if (row.type === "prerequisite" && typeof row.from === "string" && typeof row.to === "string") existingPrerequisites.set(`${row.from}:${row.to}`, { from: row.from, to: row.to });
    }
  }
  console.log(JSON.stringify({ graphVersion: subjectResult.version, topics, existingConceptIds: all.map(item => item.id), existingPrerequisites: [...existingPrerequisites.values()] }));
} else if (command === "stage") {
  const file = option("--file");
  if (!file) throw new Error("stage requires --file with a validated candidate JSON object");
  const candidate = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const result = await stageSpaceCandidate(
    candidate,
    (route, body) => requestJsonBotCrypto(requireTowerUrl(), "POST", route, body, brokerUrl),
    route => requestJsonBotCrypto(requireTowerUrl(), "GET", route, undefined, brokerUrl),
  );
  console.log(JSON.stringify(result));
} else if (command === "status") {
  const id = args[0];
  if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error("status requires candidate id");
  const result = await requestJsonBotCrypto<Record<string, unknown>>(requireTowerUrl(), "GET", `${path}/${id}`, undefined, brokerUrl);
  const candidate = result.candidate as Record<string, unknown> | undefined;
  console.log(JSON.stringify({ candidateId: id, reviewStatus: candidate?.status, baseVersion: candidate?.base_version, publishedVersion: candidate?.published_version }));
} else {
  throw new Error("Usage: bun clis/space-research.ts run --ids <id,id> | subjects --ids <id,id> | stage --file <candidate.json> | status <candidate-id> [--tower-url <url>]");
}
