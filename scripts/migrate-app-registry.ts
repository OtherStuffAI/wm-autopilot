#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { AppRegistry } from "../src/apps/app-registry";

const args = process.argv.slice(2);
const retire = args.includes("--retire-legacy");
const repo = resolve(import.meta.dir, "..");
const legacy = resolve(repo, "data/apps.json");
const database = resolve(repo, "data/app-registry.sqlite");
const secrets = resolve(repo, "data/app-registry-secrets.sqlite");

const registry = new AppRegistry(legacy, database, secrets);
const apps = await registry.listApps();
const ids = new Set(apps.map((app) => app.id));
if (ids.size !== apps.length) throw new Error("App registry verification failed: duplicate ids");
if (apps.some((app) => !app.id || !app.label || !app.root)) {
  throw new Error("App registry verification failed: missing critical metadata");
}

if (retire) await registry.retireLegacyRegistry();

console.log(JSON.stringify({
  status: retire ? "migrated_verified_and_legacy_retired" : "migrated_and_verified",
  apps: apps.length,
  legacy_present: existsSync(legacy),
  metadata_database: database,
  secret_provider_database: secrets,
}, null, 2));
