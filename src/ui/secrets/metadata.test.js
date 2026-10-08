import { expect, test } from "bun:test";
import { secretMetadata } from "./metadata.js";

test("browser metadata projection drops unexpected credential fields at every policy boundary", () => {
  const hidden = "synthetic-metadata-leak";
  const record = { id: "ref", label: "Synthetic", value: hidden, envelope: hidden,
    policy: { identities: ["public-identity"], allowExport: false, value: hidden,
      pipelines: { enabled: true, mode: "all", ids: [], token: hidden },
      agents: { enabled: false, mode: "selected", ids: [], token: hidden },
      kindRules: [{ kind: 1, maxContentBytes: 256, maxTags: 1, maxTagBytes: 128, allowedTagNames: ["p"], key: hidden }] } };
  const projected = secretMetadata(record);
  expect(JSON.stringify(projected)).not.toContain(hidden);
  expect(projected.policy.pipelines).toEqual({ enabled: true, mode: "all", ids: [] });
  expect(projected.policy.kindRules[0].kind).toBe(1);
});
