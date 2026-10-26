import { lstatSync, unlinkSync } from "node:fs";
import { connect } from "node:net";

/** Recover sockets left by abrupt exits without displacing another signer. */
export async function prepareSignerSocket(path: string): Promise<void> {
  const original = lstatSync(path, { throwIfNoEntry: false });
  if (!original) return;
  if (!original.isSocket() || original.uid !== process.getuid?.()) {
    throw new Error(`Refusing to replace signer path that is not an owned socket: ${path}`);
  }
  await new Promise<void>((resolve, reject) => {
    const probe = connect(path);
    const timer = setTimeout(() => {
      probe.destroy();
      reject(new Error(`Timed out checking existing signer socket: ${path}`));
    }, 1000);
    probe.once("connect", () => {
      clearTimeout(timer);
      probe.destroy();
      reject(new Error(`Signer socket already has an active listener: ${path}`));
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      probe.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve();
      else reject(error);
    });
  });
  const current = lstatSync(path, { throwIfNoEntry: false });
  if (!current) return;
  if (current.ino !== original.ino || current.dev !== original.dev) {
    throw new Error(`Signer socket changed while checking for a stale listener: ${path}`);
  }
  unlinkSync(path);
}
