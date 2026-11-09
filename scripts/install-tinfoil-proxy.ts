import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Explicit operator install; the running service never downloads executable code.
const version = "v0.2.9";
const platform = process.platform === "win32" ? "windows" : process.platform;
const arch = process.arch === "x64" ? "amd64" : process.arch;
const assetName = `tinfoil-proxy-${platform}-${arch}${platform === "windows" ? ".exe" : ""}`;
const response = await fetch(`https://api.github.com/repos/tinfoilsh/tinfoil-proxy/releases/tags/${version}`);
if (!response.ok) throw new Error("Cannot resolve pinned Tinfoil proxy release");
const release = await response.json() as { assets: Array<{ name: string; browser_download_url: string; digest?: string }> };
const asset = release.assets.find(item => item.name === assetName);
if (!asset?.digest?.startsWith("sha256:") || !asset.browser_download_url.startsWith(`https://github.com/tinfoilsh/tinfoil-proxy/releases/download/${version}/`)) throw new Error("Verified release asset unavailable for this platform");
const download = await fetch(asset.browser_download_url);
if (!download.ok) throw new Error("Tinfoil proxy download failed");
const bytes = new Uint8Array(await download.arrayBuffer());
if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== asset.digest) throw new Error("Tinfoil proxy release digest mismatch");
const directory = join(homedir(), ".local", "bin");
await mkdir(directory, { recursive: true, mode: 0o700 });
const destination = join(directory, assetName.endsWith(".exe") ? "tinfoil-proxy.exe" : "tinfoil-proxy");
await writeFile(`${destination}.installing`, bytes, { mode: 0o700 });
await rename(`${destination}.installing`, destination);
console.log(`Installed Tinfoil proxy ${version} at ${destination}; ${asset.digest}`);
