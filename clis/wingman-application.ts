#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { registerLocalApplication } from "../src/signing/local-application-management";
import type { ApplicationGrantPolicy } from "../src/signing/application-signer";

const args = Bun.argv.slice(2);
if (args[0] === "--help") {
  console.log(`Local trusted-operator application registration (same host UID).
Usage: bun clis/wingman-application.ts register --request-file <absolute-json> --credential-file <absolute-new-file> --data-dir <absolute-existing-data> --master-key-file <absolute-existing-master>
Request: {ownerNpub, botNpub, expectedPubkey, policy}.
Requires existing broker custody and application grant database. Does not mint
keys, sign as the human owner, use session capabilities, or alter remote policy.
The credential goes only to an exclusively created private file; stdout contains
public grant metadata. Run only for an explicitly authorized application grant.`);
} else {
  try {
    if (args[0] !== "register") throw new Error("expected_register_command");
    const names = ["--request-file", "--credential-file", "--data-dir", "--master-key-file"];
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
    const grant = await registerLocalApplication({
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
    console.error(`Local application registration failed: ${code}`);
    process.exitCode = 1;
  }
}
