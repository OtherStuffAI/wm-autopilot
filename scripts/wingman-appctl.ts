#!/usr/bin/env bun

/**
 * DEPRECATED: This script has moved to clis/appctl.ts
 *
 * Run: bun clis/appctl.ts [command] [options]
 * Or:  bun run cli:apps [command] [options]
 */

console.warn("⚠ scripts/wingman-appctl.ts is deprecated. Use clis/appctl.ts instead.");
console.warn("  Run: bun clis/appctl.ts " + Bun.argv.slice(2).join(" "));
console.warn("");

// Delegate to new location
await import("../clis/appctl");
