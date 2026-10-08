import { lstat, readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, parse } from "node:path";
import { randomUUID } from "node:crypto";

async function noSymlinks(path: string): Promise<void> {
  let current = resolve(path);
  while (current !== parse(current).root) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("Symlink evidence destination"); }
    catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
    current = dirname(current);
  }
}
export async function verifyEvidencePath(path: string): Promise<void> {
  await noSymlinks(path);
  const cwd = dirname(resolve(path));
  const rootProcess = Bun.spawn(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" });
  const root = (await new Response(rootProcess.stdout).text()).trim();
  if (await rootProcess.exited !== 0) throw new Error("Evidence destination must be in a Git repository");
  const ignored = Bun.spawn(["git", "-C", root, "check-ignore", "-q", resolve(path)], { stdout: "pipe", stderr: "pipe" });
  const tracked = Bun.spawn(["git", "-C", root, "ls-files", "--", resolve(path)], { stdout: "pipe", stderr: "pipe" });
  const files = await new Response(tracked.stdout).text();
  if (await ignored.exited !== 0 || await tracked.exited !== 0 || files.trim()) throw new Error("Operational evidence must be ignored and untracked");
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await noSymlinks(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export async function readJson(path: string): Promise<Record<string, unknown>> {
  await noSymlinks(path);
  return JSON.parse(await readFile(path, "utf8"));
}
/** Compatible with the existing atomic mkdir lock; never expires someone else's lock. */
export async function withRunLock<T>(root: string, sessionId: string, work: () => Promise<T>): Promise<T> {
  if (!sessionId) throw new Error("Missing scheduled session identity");
  const lock = join(root, "lock");
  await verifyEvidencePath(join(root, "state.json"));
  await noSymlinks(lock);
  try { await mkdir(lock); }
  catch (error) {
    if ((error as { code?: string }).code === "EEXIST") throw new Error("Schedule lock occupied; leave its owner untouched");
    throw error;
  }
  const token = randomUUID();
  const ownerPath = join(lock, "owner.json");
  try {
    await atomicJson(ownerPath, { session_id: sessionId, token, created_at: new Date().toISOString() });
    return await work();
  } finally {
    const owner = await readJson(ownerPath);
    if (owner.token !== token || owner.session_id !== sessionId) throw new Error("Lock ownership changed; leave it untouched");
    await rm(lock, { recursive: true });
  }
}
