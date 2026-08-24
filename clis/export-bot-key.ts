#!/usr/bin/env bun

console.error(
  "Agent-facing bot-key export has been retired. Use broker-aware MCP tools or " +
  "clis/wingman-capability.ts and request a narrower capability instead of a private key. " +
  "Operator recovery remains available only through the authenticated admin settings surface.",
);
process.exit(2);
