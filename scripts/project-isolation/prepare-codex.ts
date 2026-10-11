import { mkdir, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

const expectedIntegrity = "Pm0W2PnFeTEqPx+AOIwgOVB4dBtY24cuD0tx1hjCor60CbSAT7WBPZVNUINSrTCDrMndvQC67p71ZEz+gmPPkA==";
const archive = resolve(process.argv[2] ?? "");
const destination = resolve(process.argv[3] ?? "");
if (!process.argv[2] || !process.argv[3]) throw new Error("Usage: prepare-codex.ts <verified-download.tgz> <ignored-build-context>");
for (const path of [archive, destination]) {
  const ignored = Bun.spawn(["git", "check-ignore", "--quiet", path], { stdout: "ignore", stderr: "ignore" });
  if (await ignored.exited !== 0) throw new Error("Native runtime inputs and build context must be Git ignored");
}
const tracked = Bun.spawn(["git", "ls-files", "--", archive, destination], { stdout: "pipe", stderr: "ignore" });
if ((await new Response(tracked.stdout).text()).trim() || await tracked.exited !== 0) throw new Error("Native runtime inputs must be untracked");
const bytes = await readFile(archive);
if (createHash("sha512").update(bytes).digest("base64") !== expectedIntegrity) throw new Error("Codex 0.159.2 Linux arm64 archive integrity mismatch");
const list = Bun.spawn(["tar", "-tzf", archive], { stdout: "pipe", stderr: "pipe" });
const paths = (await new Response(list.stdout).text()).trim().split("\n");
if (await list.exited !== 0) throw new Error("Cannot inspect native archive");
const binary = paths.find((path) => /^package\/vendor\/aarch64-unknown-linux-musl\/(?:bin|codex)\/codex$/.test(path));
if (!binary) throw new Error("Pinned archive has no expected Linux arm64 native binary");
await mkdir(destination, { recursive: true, mode: 0o700 });
if ((await readdir(destination)).length) throw new Error("Native build context must be empty; existing files preserved");
const extract = Bun.spawn(["tar", "-xOzf", archive, binary], { stdout: Bun.file(join(destination, "codex")), stderr: "pipe" });
if (await extract.exited !== 0) throw new Error("Cannot prepare native binary");
const { chmod } = await import("node:fs/promises");
await chmod(join(destination, "codex"), 0o755);
console.log(JSON.stringify({ version: "0.159.2", architecture: "linux/arm64", sha512: expectedIntegrity, destination }));
