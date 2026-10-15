#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { wappStore } from "../src/wapps/wapp-store";
import { getWappPipelineBroker } from "../src/wapps/pipeline-broker-runtime";

// Explicit trusted local management; does not sign as the human owner or export keys.
const [command,file]=Bun.argv.slice(2);
if (command==="revoke" && file) {
  const broker=getWappPipelineBroker();
  if (!broker.grants.active(file)) throw new Error("pipeline_grant_not_active");
  broker.grants.revoke(file);
  console.log(JSON.stringify({grantId:file,revoked:true}));
  process.exit(0);
}
if (!["register","register-remote"].includes(command||"") || !file) throw new Error("Usage: wapp-pipeline-grant.ts register|register-remote request.json | revoke grant-id");
const input=JSON.parse(readFileSync(file,"utf8"));
const expected=["appId","callbackUrl","definitionId","expiresAt","installationId","origin","ownerNpub",...(command==="register-remote"?["clientOrigin"]:[])];
if (!input || Object.keys(input).sort().join(",")!==expected.sort().join(",")) throw new Error("invalid_registration_request");
wappStore.ensureLocalAppSigningIdentity(input.installationId,input.ownerNpub);
const {ownerNpub,...grantInput}=input;
const result=await getWappPipelineBroker().register(ownerNpub,{...grantInput,...(command==="register-remote"?{access:"remote"}: {})});
console.log(JSON.stringify(result,null,2)); // Public grant metadata + private opaque credential path only.
