import { execFile, spawn } from "node:child_process";
import { devNull } from "node:os";
import { isIP } from "node:net";
import { promisify } from "node:util";

const readVersion = promisify(execFile);
let curlReady: Promise<void> | undefined;

async function requireCurl(): Promise<void> {
  if (!curlReady) {
    curlReady = (async () => {
      let stdout: string;
      try {
        ({ stdout } = await readVersion("curl", ["-q", "--version"], { timeout: 1000, maxBuffer: 4096 }));
      } catch {
        throw new Error("Webhook requires curl 8.4 or newer on PATH");
      }
      const version = /^curl (\d+)\.(\d+)\./.exec(stdout);
      if (!version || Number(version[1]) < 8 || (Number(version[1]) === 8 && Number(version[2]) < 4)) {
        throw new Error("Webhook requires curl 8.4 or newer for bounded responses");
      }
    })();
  }
  try { await curlReady; } catch (error) { curlReady = undefined; throw error; }
}

const maxBodyBytes = 1024 * 1024;
const maxConfigBytes = 8 * 1024 * 1024;

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/\v/g, "\\v")}"`;
}

/** Config is sent over stdin: signed headers and payload never enter process argv. */
export function webhookCurlConfig(url: URL, address: string, body: string, headers: Record<string, string>): string {
  if (Buffer.byteLength(body) > maxBodyBytes) throw new Error("Webhook payload exceeds 1 MiB");
  const lines = [
    "silent", "show-error", 'proxy = ""', 'noproxy = "*"', 'proto = "=https"',
    "globoff", "max-time = 10", "connect-timeout = 10", "max-filesize = 65536",
    "max-redirs = 0", 'request = "POST"', `output = ${quote(devNull)}`, 'write-out = "%{http_code}"',
    `url = ${quote(url.href)}`,
    `data-raw = ${quote(body)}`,
    'header = "content-type: application/json"',
  ];
  // Literal-IP URLs are already pinned; certificate verification uses that IP identity.
  if (!isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
    lines.push(`resolve = ${quote(`${url.hostname}:${url.port || "443"}:${address.includes(":") ? `[${address}]` : address}`)}`);
  }
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid webhook header");
    if (["host", "content-length", "content-type", "transfer-encoding"].includes(name.toLowerCase())) throw new Error("Reserved webhook header");
    lines.push(`header = ${quote(`${name}: ${value}`)}`);
  }
  const config = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(config) > maxConfigBytes || config.includes("\0")) throw new Error("Webhook config exceeds limits");
  return config;
}

export async function pinnedWebhookTransport(url: URL, address: string, body: string, headers: Record<string, string>): Promise<number> {
  const config = webhookCurlConfig(url, address, body, headers);
  await requireCurl();
  return await new Promise<number>((resolve, reject) => {
    // -q must be first: never load a user's .curlrc (including insecure/proxy options).
    const child = spawn("curl", ["-q", "--config", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let status = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 11_000);
    child.stdout.on("data", (chunk: Buffer) => {
      status += chunk.toString();
      if (status.length > 3) child.kill("SIGKILL");
    });
    // Drain without retaining diagnostics: they can contain caller-supplied URL information.
    child.stderr.resume();
    child.stdin.on("error", () => {}); // A failed spawn/early exit is reported below.
    child.on("error", () => { clearTimeout(timer); reject(new Error("Webhook requires curl on PATH")); });
    child.on("close", code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("Webhook delivery timed out"));
      else if (code !== 0) reject(new Error(`Pinned webhook transport failed (curl exit ${code})`));
      else if (!/^[1-5][0-9]{2}$/.test(status)) reject(new Error("Invalid webhook HTTP status"));
      else resolve(Number(status));
    });
    child.stdin.end(config);
  });
}
