import { request } from "node:http";
import { finalizeEvent } from "nostr-tools";
import { resolveNativeFipsDestination } from "../../src/apps/native-fips-request";

// Deliberately malformed wire requests, confined to the generated test mesh.
// Successful application operations continue through the production adapter.
export async function probeMeshIngress(target: string, publicOrigin: string, outsiderKey: Uint8Array): Promise<Record<string, number>> {
  const mesh = new URL(target);
  const address = await resolveNativeFipsDestination(mesh.origin, AbortSignal.timeout(15000));
  const publicTarget = new URL(mesh.pathname, publicOrigin).href;
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "",
    tags: [["u", publicTarget], ["method", "GET"]] }, outsiderKey);
  const authorization = `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
  const send = (host: string) => new Promise<number>((resolve, reject) => {
    const req = request({ hostname: address, port: Number(mesh.port), path: mesh.pathname,
      headers: { host, authorization, "x-forwarded-host": new URL(publicOrigin).host, "x-forwarded-proto": "https" },
      signal: AbortSignal.timeout(15000), agent: false,
    }, response => { const status = response.statusCode!; response.resume(); response.on("end", () => resolve(status)); });
    req.on("error", reject); req.end();
  });
  const wrongHost = await send(new URL(publicOrigin).host);
  const forgedForwarding = await send(mesh.host);
  if (wrongHost !== 421 || forgedForwarding !== 401) throw new Error(`Mesh ingress canonical target checks failed (${wrongHost}, ${forgedForwarding})`);
  return { wrongHost, forgedForwarding };
}
