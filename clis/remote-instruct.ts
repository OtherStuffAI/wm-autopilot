#!/usr/bin/env bun

import {
  buildConfig,
  parseCommonFlags,
  requestJson,
  requestJsonBotCrypto,
  resolveBaseUrl,
} from "./lib/auth";

const USAGE = `Remote Instruct CLI (NIP-98)

Usage:
  bun clis/remote-instruct.ts get [options]

Commands:
  get                 Fetch the Remote Instruct prompt

Options:
  --url <url>         Wingman URL (env: WINGMAN_URL, default: http://localhost:3000)
  --key <nsec|hex>    Operator-only Nostr private key (env: WINGMAN_NSEC)
  --bot-crypto        Sign with this agent session's bot key
  --json              Print raw JSON response
  -h, --help          Show help`;

interface RemoteInstructResponse {
  ok: boolean;
  name: string;
  version: number;
  content: string;
  variables: Record<string, string>;
  missingVariables: string[];
}

async function fetchRemoteInstruct(options: {
  urlInput?: string;
  keyInput?: string;
  botCrypto: boolean;
}): Promise<RemoteInstructResponse> {
  if (options.botCrypto) {
    const baseUrl = resolveBaseUrl(options.urlInput);
    return requestJsonBotCrypto<RemoteInstructResponse>(
      baseUrl,
      "GET",
      "/api/remote-instruct",
    );
  }

  const { baseUrl, secretKey } = buildConfig(options.urlInput, options.keyInput);
  return requestJson<RemoteInstructResponse>(
    baseUrl,
    secretKey,
    "GET",
    "/api/remote-instruct",
  );
}

async function run() {
  const { args, urlInput, keyInput, asJson, help, botCrypto } = parseCommonFlags(Bun.argv.slice(2));
  const command = args[0]?.toLowerCase() ?? "get";

  if (help || command === "help") {
    console.log(USAGE);
    return;
  }

  if (command !== "get") {
    throw new Error(`Unknown command: ${command}`);
  }

  const response = await fetchRemoteInstruct({ urlInput, keyInput, botCrypto });
  if (asJson) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  process.stdout.write(response.content);
  if (!response.content.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
