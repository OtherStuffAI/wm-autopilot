#!/usr/bin/env bun

/**
 * Wingman delegated session management CLI.
 *
 * Uses shared broker/operator authentication and the server-side
 * maintained caller/explicit-owner session routes for authorization.
 */

import { buildAuthConfig, parseCommonFlags, requestJsonWithAuth } from "./lib/auth";

import { parseCommandOptions, validateCommandArguments, ownerApiPath } from "./lib/command-options";

const USAGE = `Wingman delegated session compatibility CLI (maintained session routes)

Usage:
  bun clis/delegate-sessions.ts <command> [id] [options]

Commands:
  list                 List sessions in caller space or explicit --owner space
  create <agent-type>  Create a delegated session
  info <id>            Show session details
  read <id>            Read live session messages
  send <id> <message>  Send a message to a session
  stop <id>            Stop a session

Options:
  --url <url>          Wingman URL (env: WINGMAN_URL, default: http://localhost:3600)
  --key <nsec|hex>     Operator-only Nostr private key (env: WINGMAN_NSEC)
  --name <name>        Session name (for create)
  --directory <path>   Working directory (for create)
  --bot-crypto         Use session capability broker
  --owner <npub>       Select explicit delegated owner space
  --model <model>      Model override (create)
  --metadata <json>    Session metadata JSON (for create)
  --json               Print raw JSON response
  -h, --help           Show help

Examples:
  bun clis/sessions.ts list --bot-crypto
  bun clis/delegate-sessions.ts create codex --name "worker" --directory /tmp/project
  bun clis/delegate-sessions.ts create codex --name "worker" --metadata '{"role":"heartbeat-worker"}'
  bun clis/delegate-sessions.ts read <session-id>
  bun clis/delegate-sessions.ts send <session-id> "run the tests"
  bun clis/delegate-sessions.ts stop <session-id>`;

interface Session {
  id?: string;
  name?: string;
  agent?: string;
  status?: string;
  workingDirectory?: string;
  [key: string]: unknown;
}

function printSessionList(sessions: Session[]) {
  if (sessions.length === 0) {
    console.log("No delegated sessions.");
    return;
  }
  console.log("ID\tNAME\tAGENT\tSTATUS\tDIRECTORY");
  for (const session of sessions) {
    console.log(
      `${String(session.id ?? "").slice(0, 8)}\t${String(session.name ?? "-")}\t${String(session.agent ?? "-")}\t${String(session.status ?? "-")}\t${String(session.workingDirectory ?? "-")}`,
    );
  }
}

function printMessages(messages: Array<Record<string, unknown>>) {
  if (messages.length === 0) {
    console.log("No messages.");
    return;
  }
  for (const msg of messages) {
    const role = String(msg.role ?? msg.type ?? "?");
    const content = String(msg.content ?? msg.message ?? msg.text ?? "");
    const ts = String(msg.createdAt ?? msg.created_at ?? msg.timestamp ?? "");
    console.log(`[${ts}] ${role}: ${content.slice(0, 300)}`);
  }
}

async function run() {
  const { args, urlInput, keyInput, asJson, help, botCrypto } = parseCommonFlags(Bun.argv.slice(2));

  const validated = parseCommandOptions(args, { "--name": "value", "--directory": "value", "--metadata": "value", "--model": "value", "--owner": "value" });
  const positional = validated.positional;
  const name = validated.options["--name"] as string | undefined;
  const owner = validated.options["--owner"] as string | undefined;
  const model = validated.options["--model"] as string | undefined;
  const directory = validated.options["--directory"] as string | undefined;
  let metadata: Record<string, unknown> | undefined;
  if (validated.options["--metadata"]) {
    const parsed = JSON.parse(String(validated.options["--metadata"]));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--metadata must be a JSON object");
    metadata = parsed;
  }

  const command = positional[0]?.toLowerCase() ?? "help";
  if (help || command === "help") {
    console.log(USAGE);
    return;
  }

  validateCommandArguments(command, positional, { list: 1, create: 2, info: 2, read: 2, logs: 2, send: 3, stop: 2 });
  if (command !== "create" && Object.keys(validated.options).some(key => key !== "--owner")) throw new Error("Creation options require create");
  const auth = buildAuthConfig(urlInput, keyInput, botCrypto);
  const req = <T>(method: string, path: string, body?: unknown) =>
    requestJsonWithAuth<T>(auth, method, ownerApiPath(path, owner), body);

  switch (command) {
    case "list": {
      const payload = await req<{ sessions?: Session[] }>("GET", "/api/sessions");
      if (!Array.isArray(payload.sessions)) throw new Error("Invalid sessions response");
      const sessions = payload.sessions;
      if (asJson) {
        console.log(JSON.stringify(sessions, null, 2));
      } else {
        printSessionList(sessions);
      }
      break;
    }

    case "create": {
      const agentType = positional[1];
      if (!agentType) throw new Error("create requires <agent-type>");
      const body: Record<string, unknown> = { agent: agentType };
      if (name) body.name = name;
      if (directory) body.directory = directory;
      if (model) body.model = model;
      if (metadata) body.metadata = metadata;
      const payload = await req<Record<string, unknown>>("POST", "/api/sessions", body);
      console.log(asJson ? JSON.stringify(payload, null, 2) : `Created delegated session: ${String(payload.id ?? "unknown")}`);
      break;
    }

    case "info": {
      const id = positional[1];
      if (!id) throw new Error("info requires <id>");
      const payload = await req<Record<string, unknown>>("GET", `/api/sessions/${encodeURIComponent(id)}`);
      console.log(JSON.stringify(payload, null, 2));
      break;
    }

    case "read":
    case "logs": {
      const id = positional[1];
      if (!id) throw new Error(`${command} requires <id>`);
      const payload = await req<{ messages?: Array<Record<string, unknown>> }>(
        "GET",
        `/api/sessions/${encodeURIComponent(id)}/messages?refresh=true`,
      );
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      if (asJson) {
        console.log(JSON.stringify(messages, null, 2));
      } else {
        printMessages(messages);
      }
      break;
    }

    case "send": {
      const id = positional[1];
      const message = positional.slice(2).join(" ");
      if (!id) throw new Error("send requires <id> <message>");
      if (!message) throw new Error("send requires a message after the session id");
      const payload = await req<Record<string, unknown>>(
        "POST",
        `/api/sessions/${encodeURIComponent(id)}/messages`,
        { content: message },
      );
      console.log(asJson ? JSON.stringify(payload, null, 2) : `Sent to ${id}`);
      break;
    }

    case "stop": {
      const id = positional[1];
      if (!id) throw new Error("stop requires <id>");
      const payload = await req<Record<string, unknown>>("DELETE", `/api/sessions/${encodeURIComponent(id)}`);
      console.log(asJson ? JSON.stringify(payload, null, 2) : `Stopped delegated session: ${id}`);
      break;
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

run().catch((error) => {
  console.error(`Error: ${(error as Error).message}`);
  process.exit(1);
});
