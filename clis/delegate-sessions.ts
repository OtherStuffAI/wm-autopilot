#!/usr/bin/env bun

/**
 * Wingman delegated session management CLI.
 *
 * Uses the caller's bot nsec directly over NIP-98 and relies on the
 * server-side bot->owner relationship to authorize session control.
 */

import { buildConfig, parseCommonFlags, requestJson, resolveBaseUrl } from "./lib/auth";

const USAGE = `Wingman delegated session management CLI

Usage:
  bun clis/delegate-sessions.ts <command> [id] [options]

Commands:
  list                 List sessions for the owner linked to this bot
  create <agent-type>  Create a delegated session
  info <id>            Show session details
  read <id>            Read live session messages
  send <id> <message>  Send a message to a session
  stop <id>            Stop a session

Options:
  --url <url>          Wingman URL (env: WINGMAN_URL, default: http://localhost:3000)
  --key <nsec|hex>     Operator-only Nostr private key (env: WINGMAN_NSEC)
  --name <name>        Session name (for create)
  --directory <path>   Working directory (for create)
  --model <model>      Model override (accepted but currently unused by the route)
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
  const { args, urlInput, keyInput, asJson, help } = parseCommonFlags(Bun.argv.slice(2));

  let name: string | undefined;
  let directory: string | undefined;
  let model: string | undefined;
  let metadata: Record<string, unknown> | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--name") {
      name = args[++i];
      if (!name) throw new Error("--name requires a value");
    } else if (flag === "--directory") {
      directory = args[++i];
      if (!directory) throw new Error("--directory requires a value");
    } else if (flag === "--model") {
      model = args[++i];
      if (!model) throw new Error("--model requires a value");
    } else if (flag === "--metadata") {
      const rawMetadata = args[++i];
      if (!rawMetadata) throw new Error("--metadata requires a JSON value");
      const parsed = JSON.parse(rawMetadata);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("--metadata must be a JSON object");
      }
      metadata = parsed as Record<string, unknown>;
    } else {
      positional.push(flag);
    }
  }

  const command = positional[0]?.toLowerCase() ?? "help";
  if (help || command === "help") {
    console.log(USAGE);
    return;
  }

  const baseUrl = resolveBaseUrl(urlInput);
  const { secretKey } = buildConfig(urlInput, keyInput);
  const req = <T>(method: string, path: string, body?: unknown) =>
    requestJson<T>(baseUrl, secretKey, method, path, body);

  switch (command) {
    case "list": {
      const payload = await req<{ sessions?: Session[] }>("GET", "/api/delegate-sessions");
      const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
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
      const payload = await req<Record<string, unknown>>("POST", "/api/delegate-sessions", body);
      console.log(asJson ? JSON.stringify(payload, null, 2) : `Created delegated session: ${String(payload.id ?? "unknown")}`);
      break;
    }

    case "info": {
      const id = positional[1];
      if (!id) throw new Error("info requires <id>");
      const payload = await req<Record<string, unknown>>("GET", `/api/delegate-sessions/${encodeURIComponent(id)}`);
      console.log(JSON.stringify(payload, null, 2));
      break;
    }

    case "read":
    case "logs": {
      const id = positional[1];
      if (!id) throw new Error(`${command} requires <id>`);
      const payload = await req<{ messages?: Array<Record<string, unknown>> }>(
        "GET",
        `/api/delegate-sessions/${encodeURIComponent(id)}/messages?refresh=true`,
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
        `/api/delegate-sessions/${encodeURIComponent(id)}/messages`,
        { content: message },
      );
      console.log(asJson ? JSON.stringify(payload, null, 2) : `Sent to ${id}`);
      break;
    }

    case "stop": {
      const id = positional[1];
      if (!id) throw new Error("stop requires <id>");
      const payload = await req<Record<string, unknown>>("DELETE", `/api/delegate-sessions/${encodeURIComponent(id)}`);
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
