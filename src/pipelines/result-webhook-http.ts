import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { pinnedWebhookTransport } from "./pinned-webhook-transport";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  blocked.addSubnet(address, prefix, "ipv6");
}
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export async function validateWebhookUrl(value: string, resolve = lookup) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) {
    throw new Error("Webhook must be HTTPS on port 443 without credentials or fragment");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
    resolve(hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("DNS resolution timed out")), 5000); timer.unref(); }),
  ]);
  if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) throw new Error("Webhook resolves to a non-public address");
  return { url, address: addresses[0]! };
}

/** Validate on every attempt, then pin the approved IP with original-host TLS verification. */
export async function postResultWebhook(url: string, body: string, headers: Record<string, string>, dependencies: { resolve?: typeof lookup; transport?: typeof pinnedWebhookTransport } = {}): Promise<number> {
  const destination = await validateWebhookUrl(url, dependencies.resolve);
  return await (dependencies.transport ?? pinnedWebhookTransport)(destination.url, destination.address.address, body, headers);
}
