import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

const binary = resolve(import.meta.dir, "..", "out", "agentapi");
const port = 47991;
const process = Bun.spawn([
  binary, "server", "--port", String(port),
  "--allowed-hosts", "localhost,127.0.0.1",
  "--allowed-origins", "http://127.0.0.1",
  "--", "/bin/sh",
], { stdin: null, stdout: "ignore", stderr: "pipe" });

try {
  let loopbackReady = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      if (response.ok) { loopbackReady = true; break; }
    } catch {}
    await Bun.sleep(100);
  }
  if (!loopbackReady) throw new Error("Patched AgentAPI did not accept a loopback connection");

  const externalAddress = Object.values(networkInterfaces()).flat()
    .find((address) => address?.family === "IPv4" && !address.internal)?.address;
  if (!externalAddress) throw new Error("No non-loopback IPv4 address is available for isolation verification");

  let externallyReachable = false;
  try {
    const response = await fetch(`http://${externalAddress}:${port}/status`, {
      headers: { host: "localhost" },
      signal: AbortSignal.timeout(1_000),
    });
    externallyReachable = response.ok;
  } catch {}
  if (externallyReachable) throw new Error("AgentAPI accepted a non-loopback request with a spoofed localhost Host header");
  console.log(JSON.stringify({ loopback: "reachable", non_loopback: "blocked", spoofed_host: "blocked" }));
} finally {
  process.kill();
  await process.exited;
}
