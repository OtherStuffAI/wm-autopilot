import { homedir } from "node:os";
import type { JsonObject } from "./pipeline-store";

export const BIRD_EXECUTABLE = "/opt/homebrew/bin/bird";
export const BIRD_LIMITS = { executions: 3, elapsedMs: 60_000, cliTimeoutMs: 12_000, outputBytes: 1_000_000, requestChars: 2_000, modelRequests: 6 };
export type BirdOperation = "following" | "for_you" | "user_tweets" | "search" | "mentions";
export interface BirdAction { operation: BirdOperation; count: number; handle?: string; query?: string; cursor?: string }
export interface BirdPage { tweets: JsonObject[]; cursor: string | null }
export type BirdExecutor = (action: BirdAction, timeoutMs: number) => Promise<BirdPage>;

export function birdArgv(action: BirdAction): string[] {
  if (!Number.isInteger(action.count) || action.count < 1 || action.count > 100) throw new Error("invalid_count");
  if (action.handle !== undefined && !/^[A-Za-z0-9_]{1,15}$/.test(action.handle)) throw new Error("invalid_handle");
  if (action.query !== undefined && (!action.query.trim() || action.query.length > 500 || /[\x00-\x1f]/.test(action.query))) throw new Error("invalid_query");
  if (action.cursor !== undefined && (!/^[A-Za-z0-9_+=:/.-]{1,2048}$/.test(action.cursor) || action.cursor.startsWith("-"))) throw new Error("invalid_cursor");
  let args: string[];
  switch (action.operation) {
    case "following": args = ["home", "--following"]; break;
    case "for_you": args = ["home"]; break;
    case "user_tweets":
      if (!action.handle) throw new Error("missing_handle");
      args = ["user-tweets", "--max-pages", "1"]; break;
    case "search":
      if (!action.query) throw new Error("missing_query");
      args = ["search", "--all", "--max-pages", "1"]; break;
    case "mentions": args = ["mentions", ...(action.handle ? ["--user", action.handle] : [])]; break;
    default: throw new Error("operation_not_allowed");
  }
  if (action.handle !== undefined && !["user_tweets", "mentions"].includes(action.operation)) throw new Error("unexpected_handle");
  if (action.query !== undefined && action.operation !== "search") throw new Error("unexpected_query");
  if (action.cursor && !["user_tweets", "search"].includes(action.operation)) throw new Error("cursor_not_supported");
  args.push("--count", String(action.count), "--json");
  if (action.cursor) args.push("--cursor", action.cursor);
  // End option parsing before every untrusted positional value.
  if (action.operation === "search") args.push("--", action.query!);
  if (action.operation === "user_tweets") args.push("--", action.handle!);
  return [BIRD_EXECUTABLE, "--timeout", "10000", "--cookie-timeout", "3000", ...args];
}

export function birdEnvironment(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const result: Record<string, string> = { HOME: homedir(), PATH: "/opt/homebrew/bin:/usr/bin:/bin", NO_COLOR: "1" };
  for (const key of ["AUTH_TOKEN", "CT0", "TMPDIR"]) if (env[key]) result[key] = env[key]!;
  return result;
}

export function parseBirdPage(raw: string): BirdPage {
  if (Buffer.byteLength(raw) > BIRD_LIMITS.outputBytes) throw new Error("output_limit");
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { throw new Error("malformed_cli_json"); }
  const object = payload as Record<string, unknown> | null;
  const tweets = Array.isArray(payload) ? payload : object?.tweets;
  if (!Array.isArray(tweets) || tweets.length > 100 || tweets.some(tweet => !tweet || typeof tweet !== "object" || typeof tweet.id !== "string" || !/^\d+$/.test(tweet.id) || typeof tweet.text !== "string")) throw new Error("invalid_cli_records");
  const cursor = !Array.isArray(payload) ? object?.nextCursor : null;
  if (cursor != null && (typeof cursor !== "string" || !/^[A-Za-z0-9_+=:/.-]{1,2048}$/.test(cursor) || cursor.startsWith("-"))) throw new Error("invalid_cli_cursor");
  return { tweets: tweets as JsonObject[], cursor: typeof cursor === "string" ? cursor : null };
}

async function readBounded(stream: ReadableStream<Uint8Array>, budget: { bytes: number }, signal: AbortSignal): Promise<string> {
  const reader = stream.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      budget.bytes += value.byteLength;
      if (budget.bytes > BIRD_LIMITS.outputBytes) throw new Error("output_limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

export const executeBird: BirdExecutor = async (action, timeoutMs) => {
  const proc = Bun.spawn(birdArgv(action), { env: birdEnvironment(), cwd: homedir(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); proc.kill(); }, Math.min(timeoutMs, BIRD_LIMITS.cliTimeoutMs));
  const budget = { bytes: 0 };
  try {
    const [stdout, stderr, code] = await Promise.all([readBounded(proc.stdout, budget, controller.signal), readBounded(proc.stderr, budget, controller.signal), proc.exited]);
    if (timedOut) throw new Error("cli_timeout");
    if (code !== 0) {
      if (/429|rate.?limit|too many requests/i.test(stderr)) throw new Error("cli_rate_limit");
      if (/401|403|auth|cookie|credential|login|log in/i.test(stderr)) throw new Error("cli_authentication");
      throw new Error("cli_failed");
    }
    return parseBirdPage(stdout);
  } catch (error) {
    controller.abort();
    proc.kill();
    await proc.exited;
    throw error;
  } finally { clearTimeout(timer); }
};
