#!/usr/bin/env bun
import { readFile } from "node:fs/promises";

function parse(argv: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const next = argv[index + 1];
    flags.set(value.slice(2), next && !next.startsWith("--") ? argv[++index]! : "true");
  }
  return { positional, flags };
}

export async function runDispatchCli(argv: string[], env = Bun.env): Promise<number> {
  const { positional, flags } = parse(argv);
  const action = positional[0] ?? "create";
  const base = (flags.get("url") ?? env.WINGMAN_URL ?? "http://127.0.0.1:3600").replace(/\/$/, "");
  const callerSessionId = env.SESSION_ID;
  const callbackSessionId = flags.get("callback-session") ?? callerSessionId;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (callerSessionId) headers["x-wingman-session-id"] = callerSessionId;
  let response: Response;
  if (action === "create") {
    const callbackEnabled = flags.get("callback") !== "false";
    if (callbackEnabled && !callbackSessionId) throw new Error("SESSION_ID or --callback-session is required; pass --callback false for unmonitored work");
    const prompt = flags.get("prompt") ?? (flags.get("prompt-file") ? await readFile(flags.get("prompt-file")!, "utf8") : "");
    if (!flags.get("agent") || !prompt.trim()) throw new Error("--agent and --prompt or --prompt-file are required");
    response = await fetch(`${base}/api/session-dispatches`, { method: "POST", headers, body: JSON.stringify({
      agent: flags.get("agent"), directory: flags.get("directory"), name: flags.get("name"), prompt,
      callback: { enabled: callbackEnabled, sessionId: callbackSessionId ?? null },
    }) });
  } else if (action === "list") {
    response = await fetch(`${base}/api/session-dispatches`, { headers });
  } else if (action === "inbox") {
    if (!callerSessionId) throw new Error("SESSION_ID is required for the exact-session inbox");
    response = await fetch(`${base}/api/session-dispatches/inbox`, { headers });
  } else {
    const id = positional[1];
    if (!id) throw new Error(`dispatch ${action} requires a dispatch ID`);
    const suffix = action === "status" ? "" : `/${action === "retry" ? "retry-callback" : action}`;
    response = await fetch(`${base}/api/session-dispatches/${id}${suffix}`, { method: action === "status" ? "GET" : "POST", headers });
  }
  const body = await response.text();
  if (!response.ok) throw new Error(`Dispatch request failed (${response.status}): ${body}`);
  console.log(JSON.stringify(JSON.parse(body), null, 2));
  return 0;
}
