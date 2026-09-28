import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { readExplainEvidence } from "./space-explain-evidence";
import type { SpaceExplainRequest } from "./space-explain-contract";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const explainGuideManifest = z.object({
  format: z.literal("space-explain-public-guides.v1"),
  towerOrigin: z.string().url(), graphVersion: z.string(), graphHash: hash,
  guides: z.record(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), hash),
}).strict();

export function guideFileHash(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readPinned(path: string, expected: string, signal: AbortSignal): Promise<unknown> {
  const file = Bun.file(path);
  if (file.size > 256_000) throw new Error("evidence_limit");
  let bytes: Buffer;
  try { bytes = await readFile(path, { signal }); }
  catch { throw new Error("evidence_unavailable"); }
  if (bytes.length > 256_000 || guideFileHash(bytes) !== expected) throw new Error("graph_mismatch");
  return JSON.parse(bytes.toString("utf8"));
}

/** Immutable public evidence prepared through the brokered CLI; never a learner cache. */
export async function readCachedExplainGuide(input: SpaceExplainRequest, config: {
  manifestPath: string; manifestHash: string; towerOrigin: string;
}, signal: AbortSignal): Promise<unknown> {
  const manifest = explainGuideManifest.parse(await readPinned(config.manifestPath, config.manifestHash, signal));
  if (manifest.towerOrigin !== config.towerOrigin || manifest.graphVersion !== input.graphVersion || manifest.graphHash !== input.graphHash) {
    throw new Error("graph_mismatch");
  }
  const expected = manifest.guides[input.conceptId];
  if (!expected) throw new Error("guide_not_cached");
  const guide = await readPinned(join(dirname(config.manifestPath), `${input.conceptId}.json`), expected, signal);
  readExplainEvidence(guide, input);
  return guide;
}
