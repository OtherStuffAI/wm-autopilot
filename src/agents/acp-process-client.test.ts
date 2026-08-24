import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcpProcessClient } from "./acp-process-client";

const clients: AcpProcessClient[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDelayedClient(delayMs: number): AcpProcessClient {
  const directory = mkdtempSync(join(tmpdir(), "wingman-acp-timeout-"));
  directories.push(directory);
  const cli = join(directory, "delayed-acp");
  writeFileSync(cli, `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n"), ${delayMs});
});
`);
  chmodSync(cli, 0o755);
  const client = new AcpProcessClient({
    command: cli,
    workingDirectory: directory,
    env: process.env as Record<string, string>,
    label: "Delayed ACP",
    requestTimeoutMs: 20,
    startupDelayMs: 10,
  });
  clients.push(client);
  return client;
}

describe("AcpProcessClient request deadlines", () => {
  test("keeps long-running requests alive when their deadline is disabled", async () => {
    const client = createDelayedClient(60);
    await client.start();

    await expect(client.request("session/prompt", {}, { timeoutMs: null })).resolves.toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
  });

  test("retains the default deadline for ordinary requests", async () => {
    const client = createDelayedClient(60);
    await client.start();

    await expect(client.request("initialize", {})).rejects.toThrow(
      "Timed out waiting for Delayed ACP initialize",
    );
  });
});
