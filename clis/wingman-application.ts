#!/usr/bin/env bun
import { isDeepStrictEqual } from "node:util";
import { normalizeNostrKindRules } from "../src/signing/nostr-kind-policy";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { registerLocalApplication, updateLocalApplicationContentBound } from "../src/signing/local-application-management";
import type { ApplicationGrantPolicy } from "../src/signing/application-signer";

const args = Bun.argv.slice(2);
if (args[0] === "--help") {
  console.log(`Local trusted-operator application registration (same host UID).
Usage: bun clis/wingman-application.ts register --request-file <absolute-json> --credential-file <absolute-new-file> --data-dir <absolute-existing-data> --master-key-file <absolute-existing-master>
Update: update-content-bound --request-file <proposed-json> --expected-request-file <original-json> --grant-file <registered-metadata-json> --data-dir <existing-data> --master-key-file <existing-master>
Updates exactly one content byte bound, comparing the complete original policy.
Request: {ownerNpub, botNpub, expectedPubkey, policy}.
Requires existing broker custody and application grant database. Does not mint
keys, sign as the human owner, use session capabilities, or alter remote policy.
The credential goes only to an exclusively created private file; stdout contains
public grant metadata. Run only for an explicitly authorized application grant.`);
} else {
  try {
    const updating = args[0] === "update-content-bound";
    if (!updating && args[0] !== "register") throw new Error("invalid_command");
    const names = ["--request-file", "--data-dir", "--master-key-file", ...(updating
      ? ["--expected-request-file", "--grant-file"] : ["--credential-file"])];
    const values = new Map<string, string>();
    for (let i = 1; i < args.length; i += 2) {
      const name = args[i]!;
      const value = args[i + 1];
      if (!names.includes(name) || values.has(name) || !value || value.startsWith("--")) throw new Error("invalid_arguments");
      values.set(name, value);
    }
    for (const name of names) if (!values.has(name)) throw new Error("missing_required_argument");
    for (const value of values.values()) if (!isAbsolute(value)) throw new Error("absolute_paths_required");
    const request = JSON.parse(readFileSync(values.get("--request-file")!, "utf8")) as {
      ownerNpub: string; botNpub: string; expectedPubkey: string; policy: ApplicationGrantPolicy;
    };
    let grant;
    if (updating) {
      const original = JSON.parse(readFileSync(values.get("--expected-request-file")!, "utf8")) as typeof request;
      const registered = JSON.parse(readFileSync(values.get("--grant-file")!, "utf8")) as { id: string; ownerNpub: string; botNpub: string; pubkey: string };
      if (registered.ownerNpub !== original.ownerNpub || registered.botNpub !== original.botNpub
        || registered.pubkey !== original.expectedPubkey) throw new Error("identity_denied");
      const normalize = (policy: ApplicationGrantPolicy): ApplicationGrantPolicy => ({ ...policy,
        allowAnyPeer: policy.allowAnyPeer === true,
        kindRules: normalizeNostrKindRules(policy.kindRules, policy.kindRules.map(rule => rule.kind)) });
      const before = normalize(original.policy), after = normalize(request.policy);
      const changed = after.kindRules.filter(rule => before.kindRules.find(old => old.kind === rule.kind)?.maxContentBytes !== rule.maxContentBytes);
      if (changed.length !== 1) throw new Error("single_content_bound_required");
      const rule = changed[0]!;
      const permitted = structuredClone(before);
      const target = permitted.kindRules.find(old => old.kind === rule.kind);
      if (!target) throw new Error("kind_denied");
      target.maxContentBytes = rule.maxContentBytes;
      if (!isDeepStrictEqual(permitted, after) || request.ownerNpub !== original.ownerNpub
        || request.botNpub !== original.botNpub || request.expectedPubkey !== original.expectedPubkey) throw new Error("only_content_bound_update_allowed");
      grant = await updateLocalApplicationContentBound({ ...original,
        dataDir: values.get("--data-dir")!, masterKeyPath: values.get("--master-key-file")!,
        expectedGrant: { id: registered.id, ownerNpub: registered.ownerNpub, botNpub: registered.botNpub,
          pubkey: registered.pubkey, policy: before }, kind: rule.kind, maxContentBytes: rule.maxContentBytes });
    } else grant = await registerLocalApplication({
      ...request,
      dataDir: values.get("--data-dir")!, masterKeyPath: values.get("--master-key-file")!,
      credentialFile: values.get("--credential-file")!,
    });
    console.log(JSON.stringify({ id: grant.id, ownerNpub: grant.ownerNpub, botNpub: grant.botNpub,
      pubkey: grant.pubkey, methods: grant.policy.methods, kinds: grant.policy.kindRules.map(rule => rule.kind) }, null, 2));
  } catch (error) {
    // Never emit filesystem error messages that could contain private paths.
    const message = error instanceof Error ? error.message : "";
    const errno = (error as { code?: string })?.code;
    const code = /^[a-z_]+$/.test(message) ? message
      : typeof errno === "string" && /^[A-Za-z_]+$/.test(errno) ? errno : "local_management_failed";
    console.error(`Local application management failed: ${code}`);
    process.exitCode = 1;
  }
}
