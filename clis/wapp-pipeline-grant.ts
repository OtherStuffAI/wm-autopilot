#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { wappStore } from "../src/wapps/wapp-store";
import { getWappPipelineBroker } from "../src/wapps/pipeline-broker-runtime";

// Explicit trusted local management; does not sign as the human owner or export keys.
const [command,file]=Bun.argv.slice(2);
if (command!=="register" || !file) throw new Error("Usage: wapp-pipeline-grant.ts register request.json");
const input=JSON.parse(readFileSync(file,"utf8"));
const expected=["appId","callbackUrl","definitionId","expiresAt","installationId","origin","ownerNpub"];
if (!input || Object.keys(input).sort().join(",")!==expected.sort().join(",")) throw new Error("invalid_registration_request");
wappStore.ensureLocalAppSigningIdentity(input.installationId,input.ownerNpub);
const {ownerNpub,...grantInput}=input;
const result=await getWappPipelineBroker().register(ownerNpub,grantInput);
console.log(JSON.stringify(result,null,2)); // Public grant metadata + private opaque credential path only.
