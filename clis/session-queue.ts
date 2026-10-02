import { requestJsonBotCrypto } from "./lib/auth";

export interface SessionQueueCliDependencies {
  env?: Record<string, string | undefined>;
  request?: (base: string, method: string, path: string, body?: unknown) => Promise<unknown>;
  stdout?: (text: string) => void;
}

export async function runSessionQueueCli(argv: string[], deps: SessionQueueCliDependencies = {}): Promise<number> {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (arg === "--json" || arg === "--bot-crypto") continue;
    if (!["--session", "--revision", "--reason", "--url", "--claim-token", "--resolution"].includes(arg)) throw new Error(`Unknown queue option: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    flags.set(arg, value);
  }
  const env = deps.env ?? Bun.env;
  const sessionId = flags.get("--session") ?? env.SESSION_ID;
  if (!sessionId?.trim()) throw new Error("SESSION_ID or --session is required");
  const action = positional[0];
  const base = flags.get("--url") ?? env.WINGMAN_URL ?? "http://127.0.0.1:3600";
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/queue`;
  const request = deps.request ?? requestJsonBotCrypto;
  let payload: unknown;
  if (action === "list" && positional.length === 1) {
    payload = await request(base, "GET", path);
  } else if (["acknowledge", "reconcile"].includes(action!) && positional.length === 2) {
    const revision = flags.get("--revision");
    const reason = flags.get("--reason");
    if (!revision || !/^[1-9][0-9]*$/.test(revision) || !reason?.trim()) {
      throw new Error("acknowledge requires <item-id> --revision <read revision> --reason <text>");
    }
    const body: Record<string, string> = { revision, reason };
    if (action === "reconcile") {
      const token = flags.get("--claim-token");
      const resolution = flags.get("--resolution");
      if (!token || !["accepted", "retry"].includes(resolution ?? "")) throw new Error("reconcile requires --claim-token and --resolution accepted|retry; retry may duplicate accepted work");
      body.claimToken = token;
      body.resolution = resolution!;
    }
    payload = await request(base, "POST", `${path}/${encodeURIComponent(positional[1]!)}/${action}`, body);
  } else {
    throw new Error("Usage: wingman session queue list | acknowledge <item-id> --revision <revision> --reason <text> [--session <id>]");
  }
  (deps.stdout ?? console.log)(JSON.stringify(payload, null, 2));
  return 0;
}
