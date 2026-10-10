import { expect, test } from "bun:test";
import { secretMetadata, hostedSiteGrantMetadata } from "./metadata.js";

test("browser metadata projection drops unexpected credential fields at every policy boundary", () => {
  const hidden = "synthetic-metadata-leak";
  const record = { id: "ref", label: "Synthetic", value: hidden, envelope: hidden,
    policy: { kindMode: "all", identities: ["public-identity"], allowExport: false, value: hidden,
      pipelines: { enabled: true, mode: "all", ids: [], token: hidden },
      agents: { enabled: false, mode: "selected", ids: [], token: hidden },
      kindRules: [{ kind: 1, maxContentBytes: 256, maxTags: 1, maxTagBytes: 128, allowedTagNames: ["p"], key: hidden }] } };
  const projected = secretMetadata(record);
  expect(JSON.stringify(projected)).not.toContain(hidden);
  expect(projected.policy.pipelines).toEqual({ enabled: true, mode: "all", ids: [] });
  expect(projected.policy.kindRules[0].kind).toBe(1);
});

test("hosted-site metadata never caches credentials or future private fields", () => {
  const hidden = "synthetic-hosted-credential";
  const projected = hostedSiteGrantMetadata({ id: "grant", appId: "app", credentialFile: "/private/grant.cap", credential: hidden, value: hidden, envelope: hidden });
  expect(projected.id).toBe("grant");
  expect(projected.credentialFile).toBe("/private/grant.cap");
  expect(JSON.stringify(projected)).not.toContain(hidden);
});

test("metadata defaults legacy policies to selected without widening", () => {
  const policy = { identities: [], pipelines: {}, agents: {}, kindRules: [] };
  expect(secretMetadata({ policy }).policy.kindMode).toBe("selected");
  expect(secretMetadata({ policy: { ...policy, kindMode: "all" } }).policy.kindMode).toBe("all");
});
