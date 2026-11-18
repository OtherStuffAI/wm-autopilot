import { isControlPlaneHostname } from "./control-origins.ts";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { checkServerIdentity } from "node:tls";
import { isIP } from "node:net";
import { isPublicAddress } from "../../pipelines/result-webhook-http.ts";

/** Policy is deliberately independent of DNS, and applied again to each redirect. */
export function publicSourceUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password || url.hash || value.length > 2048) throw Error("Source requires public HTTPS:443 without credentials or fragment");
  const host = url.hostname.toLowerCase();
  if (host.endsWith(".") || isControlPlaneHostname(host) || !host.includes(".") || /(?:^|[.-])(?:localhost|local|internal|fips|tower|autopilot|wingman|broker)(?:[.-]|$)/.test(host)) throw Error("Control-plane or local source denied");
  return url;
}

export async function publicDestination(value: string, resolve = lookup) {
  const url = publicSourceUrl(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{address: host, family: isIP(host)}] : await Promise.race([resolve(host, {all: true, verbatim: true}), new Promise<never>((_,reject) => { const timer = setTimeout(() => reject(Error("Source DNS timeout")),5000); timer.unref(); })]);
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw Error("Source DNS must contain only public addresses");
  return {url, address: addresses[0]!};
}

export interface PublicSourceResponse { url: string; mimeType: string; bytes: Buffer; redirects: string[]; pinnedAddress: string; connectedAddress: string }

/** No proxy, ambient headers, cookie jar or second DNS resolution. TLS authenticates the original hostname. */
export async function publicFetch(value: string, kind: "text" | "image", signal: AbortSignal): Promise<PublicSourceResponse> {
  let current = value;
  const redirects: string[] = [];
  for (;;) {
    signal.throwIfAborted();
    const {url, address} = await publicDestination(current);
    signal.throwIfAborted();
    const response = await pinnedGet(url, address, kind === "text" ? 512 * 1024 : 2 * 1024 * 1024, signal);
    if ([301,302,303,307,308].includes(response.status)) {
      if (redirects.length >= 2 || !response.location) throw Error("Source redirect limit or missing location");
      redirects.push(url.href);
      current = new URL(response.location, url).href;
      continue;
    }
    if (response.status !== 200) throw Error(`Source HTTP ${response.status}`);
    return {url: url.href, mimeType: response.mimeType, bytes: response.bytes, redirects, pinnedAddress: address.address, connectedAddress: response.connectedAddress};
  }
}

export function pinnedGet(url: URL, address: {address: string; family: number}, maxBytes: number, signal: AbortSignal, attachmentHeaders: Record<string,string> = {}): Promise<{status: number; location?: string; mimeType: string; bytes: Buffer; connectedAddress: string}> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET", agent: false, signal, servername: url.hostname,
      rejectUnauthorized: true, checkServerIdentity: (_host, cert) => checkServerIdentity(url.hostname, cert),
      // Bun requests all:true; Node may request the single-address callback shape.
      lookup: (_host, options, callback) => {
        if (typeof options === "object" && options.all) (callback as Function)(null, [address]);
        else (callback as Function)(null, address.address, address.family);
      },
      headers: {...attachmentHeaders,"accept": "text/html, text/plain, application/json, image/jpeg, image/png, image/webp", "accept-encoding": "identity"},
      maxHeaderSize: 16 * 1024,
    }, res => {
      const peer = res.socket.remoteAddress;
      const normalize = (ip: string) => ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : isIP(ip) === 6 ? new URL(`http://[${ip}]`).hostname : ip;
      if (!peer || normalize(peer) !== normalize(address.address)) { req.destroy(Error("Pinned source peer mismatch")); return; }
      const connectedAddress = peer;
      const status = res.statusCode ?? 0;
      if ([301,302,303,307,308].includes(status)) {
        res.destroy(); resolve({status, location: res.headers.location, mimeType: "", bytes: Buffer.alloc(0), connectedAddress}); return;
      }
      if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") { req.destroy(Error("Encoded source denied")); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(Error("Source byte limit exceeded")); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({status, mimeType: (res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase(), bytes: Buffer.concat(chunks), connectedAddress}));
    });
    req.on("error", reject);
    req.setTimeout(12_000, () => req.destroy(Error("Source transport timed out")));
    req.end();
  });
}
