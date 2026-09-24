import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { parseTowerFipsEndpoint } from "../agent-chat/tower-transport-config";
import { inspectNativeFipsRuntime, FIPS_NATIVE_CTL_PATH } from "./native-fips-runtime";

async function control(args: string[], signal: AbortSignal): Promise<string> {
  const proc = Bun.spawn([Bun.env.FIPSCTL_PATH?.trim() || FIPS_NATIVE_CTL_PATH, ...args], {
    stdout: "pipe", stderr: "pipe", signal,
  });
  const [output, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`Native FIPS ${args[0]} failed (${code})`);
  return output.trim();
}

export async function resolveNativeFipsDestination(endpoint: string, signal: AbortSignal): Promise<string> {
  const { nodeNpub } = parseTowerFipsEndpoint(endpoint);
  signal.throwIfAborted();
  if (process.platform === "darwin") {
    const status = await inspectNativeFipsRuntime({
      fipsctlPath: Bun.env.FIPSCTL_PATH,
      controlSocketPath: Bun.env.FIPS_CONTROL_SOCKET,
      run: async (argv) => {
        signal.throwIfAborted();
        const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", signal });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
        ]);
        signal.throwIfAborted();
        return { stdout, stderr, exitCode };
      },
    });
    if (!status.ready) throw new Error(status.error ?? "Native FIPS is unavailable");
  } else {
    const raw = await control(["--socket", Bun.env.FIPS_CONTROL_SOCKET?.trim() || "/app/data/fips/control.sock", "show", "status"], signal);
    const result = JSON.parse(raw);
    const status = result.data ?? result;
    if (status.state !== "running" || status.tun_state !== "active" || status.persistent !== true) {
      throw new Error("Native FIPS requires a running daemon, active TUN and persistent identity");
    }
  }
  const address = await control(["address", nodeNpub], signal);
  if (isIP(address) !== 6 || !address.startsWith("fd")) throw new Error("Native FIPS returned an invalid mesh address");
  return address;
}

/** Pin TCP to the native node-derived mesh address; retain the signed HTTP Host and target. */
export function requestNativeFips(url: URL, address: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (headers.has("host") && headers.get("host") !== url.host) throw new Error("FIPS Host differs from approved destination");
  headers.set("host", url.host);
  const signal = init.signal ?? undefined;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: address, port: Number(url.port), method: init.method ?? "GET",
      path: url.pathname + url.search, headers: Object.fromEntries(headers), signal,
      agent: false,
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        responseHeaders.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
      }
      const status = incoming.statusCode ?? 502;
      if (status >= 300 && status < 400 && status !== 304) {
        incoming.destroy();
        reject(new Error("Tower FIPS redirects are forbidden"));
        return;
      }
      const noBody = init.method === "HEAD" || [204, 205, 304].includes(status);
      if (noBody) incoming.resume();
      resolve(new Response(noBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
        status, statusText: incoming.statusMessage, headers: responseHeaders,
      }));
    });
    req.once("error", reject);
    void (async () => {
      if (init.body != null) {
        // Buffer exactly the caller's serialized bytes, without changing content type or JSON.
        const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
        signal?.throwIfAborted();
        req.end(bytes);
      } else req.end();
    })().catch((error) => { req.destroy(error); reject(error); });
  });
}
