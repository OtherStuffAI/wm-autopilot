#!/usr/bin/env bun
import { mkdir, writeFile, rename } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { spaceExplainRequest, type SpaceExplainRequest } from "../src/pipelines/space-explain-contract";
import { readExplainEvidence, publicExplainGuide } from "../src/pipelines/space-explain-evidence";
import { explainGuideManifest, guideFileHash } from "../src/pipelines/space-explain-cache";
import { fetchBrokeredExplainGuide } from "../src/pipelines/space-explain-runtime";

export async function prepareExplainCache(input: {
  ids: string[]; version: string; graphHash: string; towerOrigin: string; outputDir: string;
  fetchGuide: (request: SpaceExplainRequest, signal: AbortSignal) => Promise<unknown>;
}) {
  if (!input.ids.length || input.ids.length > 99 || new Set(input.ids).size !== input.ids.length) throw new Error("Invalid concept list");
  const tower = new URL(input.towerOrigin);
  if (tower.protocol !== "https:" || tower.origin !== input.towerOrigin) throw new Error("Configured Tower HTTPS origin required");
  const requests = input.ids.map(conceptId => spaceExplainRequest.parse({ requestId: crypto.randomUUID(), conceptId,
    mode: "explain", question: "Public guide cache preparation", style: "standard", graphVersion: input.version, graphHash: input.graphHash }));
  // New immutable directory only. Publish the manifest last; failed/partial export is never usable.
  const directory = resolve(input.outputDir);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);
  const guides: Record<string, string> = {};
  for (const request of requests) {
    const raw = await input.fetchGuide(request, AbortSignal.timeout(180_000));
    readExplainEvidence(raw, request);
    const text = `${JSON.stringify(publicExplainGuide(raw))}\n`;
    guides[request.conceptId] = guideFileHash(text);
    await writeFile(join(directory, `${request.conceptId}.json`), text, { flag: "wx" });
  }
  const manifest = explainGuideManifest.parse({ format: "space-explain-public-guides.v1", towerOrigin: tower.origin,
    graphVersion: input.version, graphHash: input.graphHash, guides });
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const path = join(directory, "manifest.json");
  await writeFile(`${path}.tmp`, text, { flag: "wx" });
  await rename(`${path}.tmp`, path);
  return { manifestPath: path, manifestHash: guideFileHash(text), concepts: requests.length };
}

async function main() {
  const args = Bun.argv.slice(2);
  if (args.includes("--help")) {
    console.log("bun clis/space-explain-cache.ts --ids concept,concept --version V --hash H --output NEW_DIR\nRequires SPACE_EXPLAIN_CLI_PATH, SPACE_EXPLAIN_TOWER_URL and active worker SESSION_ID/WINGMAN_CAPABILITY/WINGMAN_URL/BOT_NPUB. Public reads only; no private app run or activation.");
    return;
  }
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!; const value = args[i + 1];
    if (!["--ids", "--version", "--hash", "--output"].includes(key) || !value || options[key]) throw new Error("Invalid cache arguments; use --help");
    options[key] = value;
  }
  if (!options["--output"]) throw new Error("New immutable --output directory required");
  const result = await prepareExplainCache({ ids: (options["--ids"] ?? "").split(",").filter(Boolean),
    version: options["--version"] ?? "", graphHash: options["--hash"] ?? "", outputDir: options["--output"],
    towerOrigin: process.env.SPACE_EXPLAIN_TOWER_URL ?? "",
    fetchGuide: (request, signal) => fetchBrokeredExplainGuide(request, process.env, signal) });
  console.log(JSON.stringify(result));
}

if (import.meta.main) void main().catch(() => { console.error("Public guide cache preparation failed; check worker capability, pinned graph and new output directory."); process.exitCode = 1; });
