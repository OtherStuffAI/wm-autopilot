import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TinfoilProxy } from "./tinfoil-proxy";

const REPO = "tinfoilsh/tinfoil-proxy";
const MAX_RELEASE_JSON = 2_000_000;
const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const DIGEST = /^sha256:([0-9a-f]{64})$/;

export class TinfoilInstallError extends Error {
  constructor(readonly code: string) { super(`tinfoil_proxy_install_${code}`); }
}

export interface TinfoilInstallOptions {
  /** Exact release tag chosen by the operator. There is no latest or default fallback. */
  release?: string;
  /** Required in addition to `release` when the release is a prerelease. */
  allowPrerelease?: boolean;
  /** Optional operator expectations that must equal the official asset metadata. */
  expectedSha256?: string;
  expectedSize?: number;
  platform?: string;
  arch?: string;
  /** Directory receiving the installed binary. Defaults to `~/.local/bin`. */
  directory?: string;
  timeoutMs?: number;
  fetch?: (url: string, init: { signal: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;
  /** Runs the staged binary through the current handshake before it is installed; must throw to refuse. */
  probe?: (stagedPath: string, sha256: string) => Promise<void>;
}
export interface TinfoilInstallResult { release: string; prerelease: boolean; path: string; sha256: string; size: number }
interface ReleaseAsset { name: string; browser_download_url: string; digest?: string; size?: number }
interface Release { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: ReleaseAsset[] }

/** Real probe: the current TinfoilProxy start protocol, including live attestation, against the staged file. */
export async function probeWithTinfoilProxy(stagedPath: string, sha256: string): Promise<void> {
  const proxy = new TinfoilProxy({ binary: stagedPath, sha256 });
  try { await proxy.baseUrl(); } finally { proxy.close(); }
}

export function releaseAssetName(platform: string, arch: string): string {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "x64" ? "amd64" : arch;
  return `tinfoil-proxy-${os}-${cpu}${os === "windows" ? ".exe" : ""}`;
}

/** Read a response body without ever holding more than `limit` bytes. */
async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) throw new TinfoilInstallError("oversize");
  const chunks: Uint8Array[] = []; let total = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new TinfoilInstallError("download_failed");
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel().catch(() => {}); throw new TinfoilInstallError("oversize"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

function validAssetUrl(value: string, release: string, name: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.host === "github.com" && !url.search && !url.hash && !url.username
      && url.pathname === `/${REPO}/releases/download/${release}/${name}`;
  } catch { return false; }
}

/**
 * Explicit operator install of one official release asset. Stages into a private unique directory beside the destination,
 * probes the staged bytes, and only then atomically replaces the destination. Any refusal leaves the old binary untouched.
 */
export async function installTinfoilProxy(options: TinfoilInstallOptions): Promise<TinfoilInstallResult> {
  const release = options.release?.trim() ?? "";
  if (!TAG.test(release)) throw new TinfoilInstallError("release_required");
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const probe = options.probe ?? probeWithTinfoilProxy;
  const assetName = releaseAssetName(options.platform ?? process.platform, options.arch ?? process.arch);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
  const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new TinfoilInstallError("timeout"))));
  aborted.catch(() => {});
  const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, aborted]);
  const request = async (url: string, limit: number, headers?: Record<string, string>) => {
    const response = await bounded(doFetch(url, { signal: controller.signal, headers }).catch((error) => { throw error instanceof TinfoilInstallError ? error : new TinfoilInstallError("download_failed"); }));
    if (!response.ok) throw new TinfoilInstallError("download_failed");
    return bounded(readBounded(response, limit));
  };
  let staging: string | null = null;
  try {
    let meta: Release;
    try { meta = JSON.parse(new TextDecoder().decode(await request(`https://api.github.com/repos/${REPO}/releases/tags/${release}`, MAX_RELEASE_JSON, { accept: "application/vnd.github+json" }))) as Release; }
    catch (error) { throw error instanceof TinfoilInstallError ? error : new TinfoilInstallError("release_invalid"); }
    if (!meta || meta.tag_name !== release || meta.draft) throw new TinfoilInstallError("release_invalid");
    const prerelease = meta.prerelease === true || release.includes("-");
    if (prerelease && options.allowPrerelease !== true) throw new TinfoilInstallError("prerelease_not_allowed");
    const asset = Array.isArray(meta.assets) ? meta.assets.find(item => item?.name === assetName) : undefined;
    const digest = DIGEST.exec(asset?.digest ?? "")?.[1];
    if (!asset || !digest || !Number.isSafeInteger(asset.size) || asset.size! <= 0 || asset.size! > MAX_ASSET_BYTES || !validAssetUrl(asset.browser_download_url, release, assetName)) throw new TinfoilInstallError("asset_unverified");
    if (options.expectedSha256 !== undefined && options.expectedSha256.toLowerCase() !== digest) throw new TinfoilInstallError("expected_digest_mismatch");
    if (options.expectedSize !== undefined && options.expectedSize !== asset.size) throw new TinfoilInstallError("expected_size_mismatch");

    const bytes = await request(asset.browser_download_url, asset.size!);
    if (bytes.length !== asset.size) throw new TinfoilInstallError("size_mismatch");
    if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new TinfoilInstallError("digest_mismatch");

    const directory = options.directory ?? join(homedir(), ".local", "bin");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    staging = await mkdtemp(join(directory, ".tinfoil-proxy-install-"));
    const staged = join(staging, assetName);
    await writeFile(staged, bytes, { mode: 0o700, flag: "wx" });
    await chmod(staged, 0o700);
    try { await bounded(probe(staged, digest)); }
    catch (error) { throw error instanceof TinfoilInstallError ? error : new TinfoilInstallError("probe_failed"); }
    const path = join(directory, assetName.endsWith(".exe") ? "tinfoil-proxy.exe" : "tinfoil-proxy");
    await rename(staged, path);
    return { release, prerelease, path, sha256: digest, size: bytes.length };
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}
