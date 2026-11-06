#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { RecordSyncCache } from "../src/heartbeat/record-sync-cache.ts";
import { retireObsoleteRegistration } from "../src/heartbeat/record-client-retirement.ts";

// Deliberate recovery only; normal wakes never retire registrations.
const resetCurrent = process.argv.includes("--reset-current");
const [cachePath, evidencePath] = process.argv.slice(2).filter(arg => arg !== "--reset-current");
if (!cachePath || !evidencePath) throw new Error("Usage: heartbeat-retire-client.ts <cache-path> <saved-wake-evidence.json>");
const db = new Database(cachePath, { readonly: true });
let partition: string[];
try { partition = JSON.parse((db.query("SELECT partition FROM meta WHERE id=1").get() as { partition: string }).partition); }
finally { db.close(); }
const cache = new RecordSyncCache(cachePath, partition);
try { console.log(JSON.stringify(await retireObsoleteRegistration(cache, await Bun.file(evidencePath).json(), undefined, resetCurrent))); }
finally { cache.close(); }
