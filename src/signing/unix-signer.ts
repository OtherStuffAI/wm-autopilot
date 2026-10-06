import { BROKER_KEY_NOT_PROVISIONED, BROKER_KEY_IDENTITY_MISMATCH } from "./broker-key-vault";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { createServer, type Socket } from "node:net";
import { ApplicationSigner, SignerError, type SignerRequest } from "./application-signer";

export const SIGNER_MAX_FRAME_BYTES = 262144;
const REQUEST_TIMEOUT_MS = 15000;

export async function listenUnixSigner(path: string, signer: ApplicationSigner) {
  if (!isAbsolute(path)) throw new Error("Signer socket path must be absolute");
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const info = lstatSync(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new Error("Signer parent must be owner-only directory");
  // Never unlink a live or unknown socket; operator removes a stale socket after confirming no listener.
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    if (sockets.size >= 8) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let frame = Buffer.alloc(0);
    let processing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS); };
    socket.on("close", () => clearTimeout(timer));
    socket.on("data", async chunk => {
      if (processing) { socket.destroy(); return; }
      if (!frame.length) arm();
      frame = Buffer.concat([frame, chunk]);
      if (frame.length > SIGNER_MAX_FRAME_BYTES) { socket.destroy(); return; }
      const end = frame.indexOf(10);
      if (end < 0) return;
      // Strictly sequential: no pipelining/batching or unbounded request queue.
      if (end !== frame.length - 1) { socket.destroy(); return; }
      processing = true;
      let id: string | null = null;
      let response: unknown;
      try {
        const request = JSON.parse(frame.subarray(0, end).toString("utf8")) as SignerRequest;
        if (typeof request.id !== "string" || !request.id.length || request.id.length > 128) throw new SignerError("invalid_request");
        id = request.id;
        response = { id, result: await signer.execute(request) };
      } catch (error) {
        const vaultCode = (error as { code?: unknown } | null)?.code;
        const code = error instanceof SignerError ? error.code
          : vaultCode === BROKER_KEY_NOT_PROVISIONED || vaultCode === BROKER_KEY_IDENTITY_MISMATCH ? vaultCode : "signer_failed";
        response = { id, error: { code } };
      }
      frame = Buffer.alloc(0);
      if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`, () => { processing = false; clearTimeout(timer); });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { chmodSync(path, 0o600); resolve(); });
  });
  const bound = lstatSync(path);
  return { async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const current = lstatSync(path, { throwIfNoEntry: false });
    if (current?.ino === bound.ino && current.dev === bound.dev) unlinkSync(path);
  } };
}
