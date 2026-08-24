#!/usr/bin/env bun

/**
 * Wingman session management CLI (NIP-98 authenticated).
 *
 * Commands: list, create, stop, stop-self, info, metadata, metadata-update,
 *           logs, send, artifacts, queue, queue-add, queue-next,
 *           nightwatch-status, nightwatch-enable, nightwatch-disable,
 *           archive, archive-info, archive-logs, archive-metadata-update, archive-delete
 */

import { parseCommonFlags, buildConfig, requestJson, requestJsonBotCrypto, resolveBaseUrl } from "./lib/auth";
import {
  buildSessionMetadataPath,
  buildSessionMetadataUpdateBody,
} from "./lib/session-metadata-cli";

const USAGE = `Wingman session management CLI (NIP-98)

Usage:
  bun clis/sessions.ts <command> [id] [options]

Commands:
  list                 List active sessions
  create <agent-type>  Create a new session
  stop <id>            Stop and archive a session
  stop-self            Stop the current session using SESSION_ID
  info <id>            Show session details
  metadata [id]        Show session metadata (uses SESSION_ID if omitted)
  metadata-update [id] Update session metadata (uses SESSION_ID if omitted)
  logs <id>            Show session messages
  send <id> <message>  Send a message to a session
  interrupt <id>       Interrupt the active agent turn
  artifacts <id>       List session artifacts
  queue <id>           Show prompt queue
  queue-add <id> <msg> Add prompt to queue
  queue-next <id>      Execute next queued prompt
  nightwatch-status <id>  Show Night Watch state for a live session
  nightwatch-enable <id>  Enable Night Watch for a live session
  nightwatch-disable <id> Disable Night Watch for a live session
  archive              List archived sessions
  archive-info <id>    Show archived session details
  archive-logs <id>    Show archived session messages
  archive-metadata-update <id> Update archived session metadata
  archive-delete <id>  Delete an archived session

Options:
  --url <url>          Wingman URL (env: WINGMAN_URL, default: http://localhost:3000)
  --key <nsec|hex>     Operator-only Nostr private key (env: WINGMAN_NSEC)
  --name <name>        Session name (for create)
  --directory <path>   Working directory (for create)
  --model <model>      Model override (for create)
  --nightwatch <true|false> Enable/disable Night Watch on session start
  --nightwatchman <true|false> Alias for --nightwatch
  --nightwatch-prompt <text> Prompt used by Night Watch check-ins
  --nightwatch-interval <n>  Minutes between Night Watch check-ins
  --nightwatch-max-cycles <n> Maximum number of Night Watch check-ins
  --goal <text>        Session goal metadata (for metadata-update)
  --next-action <type> Session hook action: none|reflect|stop|restart
  --next-action-payload <text> Payload for the next action hook
  --next-action-template <text> Template for reflect hooks, e.g. "Goal: {{goal}}"
  --binding-type <type> Binding type: thread|task|flow_run
  --binding-id <id>    Binding identifier
  --flow-id <id>       Flow identifier
  --flow-run-id <id>   Flow run identifier
  --tags <tags>        Comma or space separated session tags
  --owner <npub>       Use delegated owner-space routes for live session and archive commands
  --limit <n>          Pagination limit (for archive, default: 50)
  --offset <n>         Pagination offset (for archive)
  --filter <text>      Filter archived sessions
  --since <iso>        Only list archived sessions since this ISO timestamp
  --bot-crypto         Sign via bot-crypto API (for agent sessions)
  --json               Print raw JSON response
  -h, --help           Show help

Examples:
  bun clis/sessions.ts list
  bun clis/sessions.ts create claude-code --name "my-task" --directory /tmp/project --nightwatch true
  bun clis/sessions.ts list --owner npub1owner...
  bun clis/sessions.ts create codex --owner npub1owner... --name "worker" --directory /srv/projects/example
  bun clis/sessions.ts archive --owner npub1owner... --limit 20
  bun clis/sessions.ts logs abc123
  bun clis/sessions.ts metadata abc123
  bun clis/sessions.ts metadata-update --goal "Ship the release" --next-action reflect
  bun clis/sessions.ts nightwatch-enable abc123 --nightwatch-prompt "Any progress?" --nightwatch-interval 10
  bun clis/sessions.ts artifacts abc123
  bun clis/sessions.ts queue abc123
  bun clis/sessions.ts queue-add abc123 "run the tests"
  bun clis/sessions.ts stop-self --bot-crypto
  bun clis/sessions.ts archive --limit 20
  bun clis/sessions.ts stop abc123`;

interface Session {
  id?: string;
  name?: string;
  agent?: string;
  status?: string;
  directory?: string;
  created?: string;
  lastUpdatedAt?: string | null;
  [key: string]: unknown;
}

interface NightWatchState {
  sessionId?: string;
  enabled?: boolean;
  cycleCount?: number;
  maxCycles?: number;
  prompt?: string | null;
  intervalMinutes?: number | null;
  promptAt?: string | null;
  [key: string]: unknown;
}

const VALID_NEXT_ACTIONS = new Set(["none", "reflect", "stop", "restart"]);
const VALID_BINDING_TYPES = new Set(["thread", "task", "flow_run"]);

function parseBooleanFlag(value: string | undefined, flagName: string): boolean {
  if (value === undefined) {
    throw new Error(`${flagName} requires a value: true or false`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${flagName} must be true or false`);
}

function parsePositiveIntegerFlag(value: string | undefined, flagName: string): number {
  if (value === undefined) {
    throw new Error(`${flagName} requires a numeric value`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return parsed;
}

function printSessionList(sessions: Session[]) {
  if (sessions.length === 0) {
    console.log("No active sessions.");
    return;
  }
  console.log("ID\tNAME\tAGENT\tSTATUS\tDIRECTORY");
  for (const s of sessions) {
    const id = String(s.id ?? "").slice(0, 8);
    const name = String(s.name ?? "-");
    const agent = String(s.agent ?? "-");
    const status = String(s.status ?? "-");
    const dir = String(s.directory ?? "-");
    console.log(`${id}\t${name}\t${agent}\t${status}\t${dir}`);
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
    const ts = msg.timestamp ?? msg.created_at ?? "";
    console.log(`[${ts}] ${role}: ${content.slice(0, 200)}`);
  }
}

function printNightWatchState(state: NightWatchState) {
  console.log(`Session:        ${String(state.sessionId ?? "-")}`);
  console.log(`Enabled:        ${state.enabled ? "yes" : "no"}`);
  console.log(`Cycle Count:    ${String(state.cycleCount ?? 0)}`);
  console.log(`Max Cycles:     ${String(state.maxCycles ?? "-")}`);
  console.log(`Interval Min:   ${String(state.intervalMinutes ?? "-")}`);
  console.log(`Prompt At:      ${String(state.promptAt ?? "-")}`);
  console.log(`Prompt:         ${String(state.prompt ?? "-")}`);
}

async function run() {
  const { args, urlInput, keyInput, asJson, help, botCrypto } = parseCommonFlags(Bun.argv.slice(2));

  // Extract session-specific flags
  let name: string | undefined;
  let directory: string | undefined;
  let model: string | undefined;
  let nightwatchEnabled: boolean | undefined;
  let nightwatchPrompt: string | undefined;
  let nightwatchInterval: number | undefined;
  let nightwatchMaxCycles: number | undefined;
  let goal: string | undefined;
  let nextAction: string | undefined;
  let nextActionPayload: string | undefined;
  let nextActionTemplate: string | undefined;
  let bindingType: string | undefined;
  let bindingId: string | undefined;
  let flowId: string | undefined;
  let flowRunId: string | undefined;
  let tags: string | undefined;
  let owner: string | undefined;
  let limit: string | undefined;
  let offset: string | undefined;
  let filter: string | undefined;
  let since: string | undefined;
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
    } else if (flag === "--nightwatch" || flag === "--nightwatchman") {
      nightwatchEnabled = parseBooleanFlag(args[++i], flag);
    } else if (flag === "--nightwatch-prompt") {
      nightwatchPrompt = args[++i];
      if (!nightwatchPrompt) throw new Error("--nightwatch-prompt requires a value");
    } else if (flag === "--nightwatch-interval") {
      nightwatchInterval = parsePositiveIntegerFlag(args[++i], "--nightwatch-interval");
    } else if (flag === "--nightwatch-max-cycles") {
      nightwatchMaxCycles = parsePositiveIntegerFlag(args[++i], "--nightwatch-max-cycles");
    } else if (flag === "--goal") {
      goal = args[++i];
      if (goal === undefined) throw new Error("--goal requires a value");
    } else if (flag === "--next-action") {
      const value = args[++i];
      if (value === undefined) throw new Error("--next-action requires a value");
      const normalized = value.trim().toLowerCase();
      if (!VALID_NEXT_ACTIONS.has(normalized)) {
        throw new Error("--next-action must be one of: none, reflect, stop, restart");
      }
      nextAction = normalized;
    } else if (flag === "--next-action-payload") {
      nextActionPayload = args[++i];
      if (nextActionPayload === undefined) throw new Error("--next-action-payload requires a value");
    } else if (flag === "--next-action-template") {
      nextActionTemplate = args[++i];
      if (nextActionTemplate === undefined) throw new Error("--next-action-template requires a value");
    } else if (flag === "--binding-type") {
      const value = args[++i];
      if (value === undefined) throw new Error("--binding-type requires a value");
      const normalized = value.trim().toLowerCase();
      if (!VALID_BINDING_TYPES.has(normalized)) {
        throw new Error("--binding-type must be one of: thread, task, flow_run");
      }
      bindingType = normalized;
    } else if (flag === "--binding-id") {
      bindingId = args[++i];
      if (bindingId === undefined) throw new Error("--binding-id requires a value");
    } else if (flag === "--flow-id") {
      flowId = args[++i];
      if (flowId === undefined) throw new Error("--flow-id requires a value");
    } else if (flag === "--flow-run-id") {
      flowRunId = args[++i];
      if (flowRunId === undefined) throw new Error("--flow-run-id requires a value");
    } else if (flag === "--tags") {
      tags = args[++i];
      if (tags === undefined) throw new Error("--tags requires a value");
    } else if (flag === "--owner") {
      owner = args[++i];
      if (!owner) throw new Error("--owner requires a value");
    } else if (flag === "--limit") {
      limit = args[++i];
      if (!limit) throw new Error("--limit requires a value");
    } else if (flag === "--offset") {
      offset = args[++i];
      if (!offset) throw new Error("--offset requires a value");
    } else if (flag === "--filter") {
      filter = args[++i];
      if (!filter) throw new Error("--filter requires a value");
    } else if (flag === "--since") {
      since = args[++i];
      if (!since) throw new Error("--since requires a value");
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
  const ownerTarget = owner?.trim();

  function sessionCollectionPath(): string {
    if (ownerTarget) {
      return `/api/owners/${encodeURIComponent(ownerTarget)}/sessions`;
    }
    return "/api/sessions";
  }

  function archiveCollectionPath(): string {
    if (ownerTarget) {
      return `/api/owners/${encodeURIComponent(ownerTarget)}/archive`;
    }
    return "/api/archive";
  }

  function archivePath(id: string): string {
    return `${archiveCollectionPath()}/${encodeURIComponent(id)}`;
  }

  function archiveMessagesPath(id: string): string {
    return `${archivePath(id)}/messages`;
  }

  function archiveMetadataPath(id: string): string {
    return `${archivePath(id)}/metadata`;
  }

  function sessionPath(id: string): string {
    return `${sessionCollectionPath()}/${encodeURIComponent(id)}`;
  }

  function sessionMetadataPath(id: string): string {
    return buildSessionMetadataPath(id, ownerTarget);
  }

  function sessionMessagesPath(id: string, options?: { refresh?: boolean }): string {
    const basePath = `${sessionPath(id)}/messages`;
    return options?.refresh ? `${basePath}?refresh=true` : basePath;
  }

  function sessionArtifactsPath(id: string): string {
    return `${sessionPath(id)}/artifacts`;
  }

  function sessionInterruptPath(id: string): string {
    return `${sessionPath(id)}/interrupt`;
  }

  function sessionQueuePath(id: string): string {
    return `${sessionPath(id)}/queue`;
  }

  function sessionQueueNextPath(id: string): string {
    return `${sessionQueuePath(id)}/next`;
  }

  function nightWatchSessionPath(id: string): string {
    return `/api/nightwatch/sessions/${encodeURIComponent(id)}`;
  }

  function nightWatchEnablePath(id: string): string {
    return `${nightWatchSessionPath(id)}/enable`;
  }

  function nightWatchDisablePath(id: string): string {
    return `${nightWatchSessionPath(id)}/disable`;
  }

  function ensureSelfSpaceOnly(commandName: string): void {
    if (ownerTarget) {
      throw new Error(`${commandName} does not support --owner yet`);
    }
  }

  function buildNightWatchRequestBody(): false | Record<string, unknown> | undefined {
    const hasNightWatchFields =
      nightwatchEnabled !== undefined ||
      nightwatchPrompt !== undefined ||
      nightwatchInterval !== undefined ||
      nightwatchMaxCycles !== undefined;
    if (!hasNightWatchFields) {
      return undefined;
    }
    if (
      nightwatchEnabled === false &&
      nightwatchPrompt === undefined &&
      nightwatchInterval === undefined &&
      nightwatchMaxCycles === undefined
    ) {
      return false;
    }

    const payload: Record<string, unknown> = {};
    if (nightwatchEnabled !== undefined) payload.enabled = nightwatchEnabled;
    if (nightwatchPrompt !== undefined) payload.prompt = nightwatchPrompt;
    if (nightwatchInterval !== undefined) payload.intervalMinutes = nightwatchInterval;
    if (nightwatchMaxCycles !== undefined) payload.maxCycles = nightwatchMaxCycles;
    return payload;
  }

  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (botCrypto) {
      return requestJsonBotCrypto<T>(baseUrl, method, path, body);
    }
    const { secretKey } = buildConfig(urlInput, keyInput);
    return requestJson<T>(baseUrl, secretKey, method, path, body);
  }

  async function resolveActiveSessionId(requestedId: string): Promise<string> {
    const payload = await req<{ sessions?: Session[] }>("GET", sessionCollectionPath());
    const sessions = Array.isArray(payload.sessions)
      ? payload.sessions
      : Array.isArray(payload) ? (payload as Session[]) : [];
    const exactMatch = sessions.find((session) => String(session.id ?? "") === requestedId);
    if (exactMatch?.id) return String(exactMatch.id);

    const prefixMatches = sessions.filter((session) => String(session.id ?? "").startsWith(requestedId));
    if (prefixMatches.length === 1 && prefixMatches[0]?.id) {
      return String(prefixMatches[0].id);
    }
    if (prefixMatches.length > 1) {
      const ids = prefixMatches.map((session) => String(session.id ?? "")).join(", ");
      throw new Error(`Ambiguous session id '${requestedId}'. Matches: ${ids}`);
    }
    return requestedId;
  }

  function resolveMetadataTargetId(rawId: string | undefined, commandName: string): string {
    const sessionId = rawId ?? process.env.SESSION_ID ?? Bun.env.SESSION_ID;
    if (!sessionId) {
      throw new Error(`${commandName} requires <id> or SESSION_ID in the environment`);
    }
    return sessionId;
  }

  switch (command) {
    case "list": {
      const payload = await req<{ sessions?: Session[] }>("GET", sessionCollectionPath());
      const sessions = Array.isArray(payload.sessions)
        ? payload.sessions
        : Array.isArray(payload) ? (payload as Session[]) : [];
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
      const nightWatchBody = buildNightWatchRequestBody();
      if (nightWatchBody !== undefined) {
        body.nightwatch = nightWatchBody;
      }
      const payload = await req<Record<string, unknown>>("POST", sessionCollectionPath(), body);
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const sessionId = String(payload.id ?? payload.sessionId ?? "unknown");
        console.log(`Created session: ${sessionId}`);
      }
      break;
    }

    case "stop": {
      const id = positional[1];
      if (!id) throw new Error("stop requires <id>");
      const resolvedId = await resolveActiveSessionId(id);
      await req("DELETE", sessionPath(resolvedId));
      console.log(`Stopped: ${resolvedId}`);
      break;
    }

    case "stop-self": {
      ensureSelfSpaceOnly("stop-self");
      const sessionId = process.env.SESSION_ID || Bun.env.SESSION_ID;
      if (!sessionId) throw new Error("stop-self requires SESSION_ID in the environment");
      await req("DELETE", sessionPath(sessionId));
      console.log(`Stopped: ${sessionId}`);
      break;
    }

    case "info": {
      const id = positional[1];
      if (!id) throw new Error("info requires <id>");
      const resolvedId = await resolveActiveSessionId(id);
      const payload = await req<Record<string, unknown>>("GET", sessionPath(resolvedId));
      console.log(JSON.stringify(payload, null, 2));
      break;
    }

    case "metadata": {
      const id = resolveMetadataTargetId(positional[1], "metadata");
      const resolvedId = await resolveActiveSessionId(id);
      const payload = await req<Record<string, unknown>>("GET", sessionMetadataPath(resolvedId));
      console.log(JSON.stringify(payload, null, 2));
      break;
    }

    case "metadata-update": {
      const id = resolveMetadataTargetId(positional[1], "metadata-update");
      const resolvedId = await resolveActiveSessionId(id);
      const body = buildSessionMetadataUpdateBody({
        goal,
        nextAction,
        nextActionPayload,
        nextActionTemplate,
        bindingType,
        bindingId,
        flowId,
        flowRunId,
        tags,
      });
      if (!body) {
        throw new Error("metadata-update requires at least one metadata flag");
      }
      const payload = await req<Record<string, unknown>>("PATCH", sessionMetadataPath(resolvedId), body);
      console.log(JSON.stringify(payload, null, 2));
      break;
    }

    case "logs": {
      const id = positional[1];
      if (!id) throw new Error("logs requires <id>");
      const resolvedId = await resolveActiveSessionId(id);
      const payload = await req<{ messages?: Array<Record<string, unknown>> }>(
        "GET", sessionMessagesPath(resolvedId, { refresh: true }),
      );
      const messages = Array.isArray(payload.messages)
        ? payload.messages
        : Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : [];
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
      const resolvedId = await resolveActiveSessionId(id);
      const payload = await req<Record<string, unknown>>(
        "POST", sessionMessagesPath(resolvedId), { content: message },
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Sent to ${resolvedId}`);
      }
      break;
    }

    case "interrupt": {
      const id = positional[1];
      if (!id) throw new Error("interrupt requires <id>");
      const resolvedId = await resolveActiveSessionId(id);
      const payload = await req<Record<string, unknown>>(
        "POST", sessionInterruptPath(resolvedId),
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Interrupted active turn for ${resolvedId}`);
      }
      break;
    }

    case "artifacts": {
      ensureSelfSpaceOnly("artifacts");
      const id = positional[1];
      if (!id) throw new Error("artifacts requires <id>");
      const resolvedId = await resolveActiveSessionId(id);
      const payload = await req<{ artifacts?: Array<Record<string, unknown>> }>(
        "GET", sessionArtifactsPath(resolvedId),
      );
      const artifacts = Array.isArray(payload.artifacts)
        ? payload.artifacts
        : Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : [];
      if (asJson) {
        console.log(JSON.stringify(artifacts, null, 2));
      } else {
        if (artifacts.length === 0) {
          console.log("No artifacts.");
        } else {
          for (const a of artifacts) {
            const name = String(a.name ?? a.path ?? a.filename ?? "?");
            const type = String(a.type ?? a.kind ?? "-");
            console.log(`  ${name}\t${type}`);
          }
        }
      }
      break;
    }

    case "queue": {
      const id = positional[1];
      if (!id) throw new Error("queue requires <id>");
      const resolvedId = await resolveActiveSessionId(id);
      const payload = await req<{ queue?: Array<Record<string, unknown>> }>(
        "GET", sessionQueuePath(resolvedId),
      );
      const queue = Array.isArray(payload.queue)
        ? payload.queue
        : Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : [];
      if (asJson) {
        console.log(JSON.stringify(queue, null, 2));
      } else {
        if (queue.length === 0) {
          console.log("Queue empty.");
        } else {
          for (const item of queue) {
            const promptId = String(item.id ?? "?").slice(0, 8);
            const content = String(item.content ?? item.prompt ?? "").slice(0, 100);
            const status = String(item.status ?? "-");
            console.log(`  ${promptId}\t${status}\t${content}`);
          }
        }
      }
      break;
    }

    case "queue-add": {
      const id = positional[1];
      const prompt = positional.slice(2).join(" ");
      if (!id) throw new Error("queue-add requires <id> <prompt>");
      if (!prompt) throw new Error("queue-add requires a prompt after the session id");
      const resolvedId = await resolveActiveSessionId(id);
      const payload = await req<Record<string, unknown>>(
        "POST", sessionQueuePath(resolvedId), { content: prompt },
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Queued prompt for ${resolvedId}`);
      }
      break;
    }

    case "queue-next": {
      const id = positional[1];
      if (!id) throw new Error("queue-next requires <id>");
      const resolvedId = await resolveActiveSessionId(id);
      const payload = await req<Record<string, unknown>>(
        "POST", sessionQueueNextPath(resolvedId),
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Executing next prompt for ${resolvedId}`);
      }
      break;
    }

    case "nightwatch-status": {
      const id = positional[1];
      if (!id) throw new Error("nightwatch-status requires <id>");
      const resolvedId = await resolveActiveSessionId(id);
      const payload = await req<NightWatchState>("GET", nightWatchSessionPath(resolvedId));
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        printNightWatchState(payload);
      }
      break;
    }

    case "nightwatch-enable": {
      const id = positional[1];
      if (!id) throw new Error("nightwatch-enable requires <id>");
      if (nightwatchEnabled === false) {
        throw new Error("nightwatch-enable cannot be used with --nightwatch false");
      }
      const resolvedId = await resolveActiveSessionId(id);
      const body = buildNightWatchRequestBody();
      const payload = await req<NightWatchState>(
        "POST",
        nightWatchEnablePath(resolvedId),
        body === false || body === undefined ? {} : body,
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Enabled Night Watch for ${resolvedId}`);
      }
      break;
    }

    case "nightwatch-disable": {
      const id = positional[1];
      if (!id) throw new Error("nightwatch-disable requires <id>");
      const resolvedId = await resolveActiveSessionId(id);
      const payload = await req<NightWatchState>("POST", nightWatchDisablePath(resolvedId));
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Disabled Night Watch for ${resolvedId}`);
      }
      break;
    }

    case "archive": {
      const params = new URLSearchParams();
      if (limit) params.set("limit", limit);
      if (offset) params.set("offset", offset);
      if (filter) params.set("filter", filter);
      if (since) params.set("since", since);
      const qs = params.toString();
      const path = `${archiveCollectionPath()}${qs ? `?${qs}` : ""}`;
      const payload = await req<{ sessions?: Session[]; archives?: Session[] }>("GET", path);
      const archives = Array.isArray(payload.sessions)
        ? payload.sessions
        : Array.isArray(payload.archives)
          ? payload.archives
          : Array.isArray(payload) ? (payload as Session[]) : [];
      if (asJson) {
        console.log(JSON.stringify(archives, null, 2));
      } else {
        if (archives.length === 0) {
          console.log("No archived sessions.");
        } else {
          console.log("ID\tNAME\tAGENT\tTAGS\tSTATUS");
          for (const s of archives) {
            const id = String(s.id ?? "").slice(0, 8);
            const metadata = s.metadata && typeof s.metadata === "object" ? s.metadata as Record<string, unknown> : {};
            const tagList = Array.isArray(metadata.tags) ? metadata.tags.join(",") : "-";
            console.log(`${id}\t${s.name ?? "-"}\t${s.agent ?? "-"}\t${tagList}\t${s.status ?? "archived"}`);
          }
        }
      }
      break;
    }

    case "archive-info": {
      const id = positional[1];
      if (!id) throw new Error("archive-info requires <id>");
      const payload = await req<Record<string, unknown>>("GET", archivePath(id));
      console.log(JSON.stringify(payload, null, 2));
      break;
    }

    case "archive-logs": {
      const id = positional[1];
      if (!id) throw new Error("archive-logs requires <id>");
      const payload = await req<{ messages?: Array<Record<string, unknown>> }>(
        "GET", archiveMessagesPath(id),
      );
      const messages = Array.isArray(payload.messages)
        ? payload.messages
        : Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : [];
      if (asJson) {
        console.log(JSON.stringify(messages, null, 2));
      } else {
        printMessages(messages);
      }
      break;
    }

    case "archive-metadata-update": {
      const id = positional[1];
      if (!id) throw new Error("archive-metadata-update requires <id>");
      const body = buildSessionMetadataUpdateBody({
        goal,
        nextAction,
        nextActionPayload,
        nextActionTemplate,
        bindingType,
        bindingId,
        flowId,
        flowRunId,
        tags,
      });
      if (!body) {
        throw new Error("archive-metadata-update requires at least one metadata flag");
      }
      const payload = await req<Record<string, unknown>>("PATCH", archiveMetadataPath(id), body);
      console.log(JSON.stringify(payload, null, 2));
      break;
    }

    case "archive-delete": {
      const id = positional[1];
      if (!id) throw new Error("archive-delete requires <id>");
      await req("DELETE", archivePath(id));
      console.log(`Deleted archive: ${id}`);
      break;
    }

    default:
      throw new Error(`Unknown command: ${command}. Run with --help for usage.`);
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
