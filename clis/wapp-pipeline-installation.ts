#!/usr/bin/env bun
import {readFileSync} from "node:fs";
import {appRegistry} from "../src/apps/app-registry";
import {wappStore} from "../src/wapps/wapp-store";
import {ensureLocalPipelineInstallation} from "../src/wapps/local-pipeline-installation";
const [command,file]=Bun.argv.slice(2);
if(command!=="ensure"||!file)throw new Error("Usage: wapp-pipeline-installation.ts ensure request.json");
console.log(JSON.stringify(await ensureLocalPipelineInstallation(wappStore,async id=>appRegistry.getApp(id),JSON.parse(readFileSync(file,"utf8"))),null,2));
