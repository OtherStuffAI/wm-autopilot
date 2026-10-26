import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSignerSocket } from "./unix-signer-socket";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function socketPath() {
  const dir = mkdtempSync(join(tmpdir(), "signer-socket-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "signer.sock");
}

test("allows an absent socket", async () => {
  await prepareSignerSocket(socketPath());
});

test("preserves an active listener", async () => {
  const path = socketPath();
  const server = createServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(path, resolve));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const before = lstatSync(path);
  await expect(prepareSignerSocket(path)).rejects.toThrow("active listener");
  expect(lstatSync(path).ino).toBe(before.ino);
});

test("removes a socket left by an abruptly terminated process", async () => {
  const path = socketPath();
  const child = Bun.spawn([process.execPath, "-e", 'const net = require("node:net"); net.createServer().listen(process.argv[1], () => console.log("ready"));', path], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("ready");
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
  expect(lstatSync(path).isSocket()).toBe(true);
  await prepareSignerSocket(path);
  expect(lstatSync(path, { throwIfNoEntry: false })).toBeUndefined();
});

test("refuses regular files and symlinks", async () => {
  const path = socketPath();
  writeFileSync(path, "keep");
  await expect(prepareSignerSocket(path)).rejects.toThrow("not an owned socket");
  const link = path + ".link";
  symlinkSync(path, link);
  await expect(prepareSignerSocket(link)).rejects.toThrow("not an owned socket");
});
