#!/usr/bin/env bun

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";

import { fileWatcherStore } from "../src/storage/file-watcher-store";

const determineHomeDirectory = () => {
  const fromEnv = Bun.env.HOME?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    return homedir();
  } catch {
    return ".";
  }
};

const homeDirectory = (() => {
  const candidate = determineHomeDirectory();
  try {
    return normalize(realpathSync(candidate));
  } catch {
    return normalize(candidate);
  }
})();

const wingmenRoot = join(homeDirectory, ".wingmen");

const formatJson = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const main = () => {
  const ensureDefault = Bun.env.WINGMAN_ENSURE_DEFAULT_WATCHERS !== "0";
  if (ensureDefault) {
    try {
      fileWatcherStore.ensureStopSessionWatcher();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to ensure default stop-session watcher: ${message}`);
    }
    try {
      fileWatcherStore.ensureStartSessionWatcher();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to ensure default start-session watcher: ${message}`);
    }
  }

  const watchers = fileWatcherStore.listWatchers();
  if (watchers.length === 0) {
    console.log("No file watchers configured.");
    return;
  }

  console.log(`Found ${watchers.length} file watcher${watchers.length === 1 ? "" : "s"}:\n`);
  for (const watcher of watchers) {
    console.log(`• ${watcher.name} [${watcher.id}]`);
    console.log(`  Directory : ${normalize(join(wingmenRoot, watcher.relativeDir))}`);
    console.log(`  Pattern   : ${watcher.pattern}`);
    console.log(`  Pointer   : ${watcher.payloadPointer}`);
    console.log(`  Expected  : ${formatJson(watcher.expectedPayload)}`);
    console.log(`  Action    : ${watcher.actionKey}`);
    console.log(`  Options   : ${formatJson(watcher.options)}`);
    console.log(`  Enabled   : ${watcher.enabled ? "yes" : "no"}`);
    if (watcher.lastTriggeredAt) {
      console.log(`  Triggered : ${watcher.lastTriggeredAt}`);
    }
    if (watcher.lastError) {
      console.log(`  Last error: ${watcher.lastError}`);
    }
    console.log("");
  }
};

main();
