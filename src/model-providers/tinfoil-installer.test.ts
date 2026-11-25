import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTinfoilProxy, releaseAssetName, TinfoilInstallError, type TinfoilInstallOptions } from "./tinfoil-installer";

// Fakes only: no network, no real binary execution, no real attestation.
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const TAG = "v0.3.0-rc.8";
const NAME = releaseAssetName("darwin", "arm64");
const BODY = new TextEncoder().encode("new-binary-bytes");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const url = (tag = TAG, name = NAME) => `https://github.com/tinfoilsh/tinfoil-proxy/releases/download/${tag}/${name}`;

function setup(patch: { release?: Record<string, unknown>; asset?: Record<string, unknown>; body?: Uint8Array; hang?: boolean; probe?: TinfoilInstallOptions["probe"] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "tinfoil-install-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const installed = join(directory, "tinfoil-proxy");
  writeFileSync(installed, "old-binary");
  const asset = { name: NAME, browser_download_url: url(), digest: `sha256:${sha(BODY)}`, size: BODY.length, ...patch.asset };
  const release = { tag_name: TAG, prerelease: true, draft: false, assets: [asset], ...patch.release };
  const urls: string[] = [];
  const fetch: TinfoilInstallOptions["fetch"] = (target, init) => {
    urls.push(target);
    if (patch.hang) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    if (target.startsWith("https://api.github.com/")) return Promise.resolve(new Response(JSON.stringify(release)));
    return Promise.resolve(new Response(patch.body ?? BODY));
  };
  const probed: Array<{ path: string; sha256: string; mode: number }> = [];
  const probe = patch.probe ?? (async (path: string, sha256: string) => { probed.push({ path, sha256, mode: statSync(path).mode & 0o777 }); });
  const run = (extra: TinfoilInstallOptions = {}) => installTinfoilProxy({ release: TAG, allowPrerelease: true, platform: "darwin", arch: "arm64", directory, fetch, probe, timeoutMs: 300, ...extra });
  return { run, installed, directory, urls, probed };
}
const refusal = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { expect(error).toBeInstanceOf(TinfoilInstallError); return (error as TinfoilInstallError).code; } throw new Error("accepted"); };
const unchanged = (f: ReturnType<typeof setup>) => {
  expect(readFileSync(f.installed, "utf8")).toBe("old-binary");
  expect(readdirSync(f.directory)).toEqual(["tinfoil-proxy"]);
};

test("an explicit release is required and nothing is fetched without one", async () => {
  for (const release of [undefined, "", "latest", "v0.2", "../v1.0.0", "v1.0.0/../x"]) {
    const f = setup();
    expect(await refusal(f.run({ release }))).toBe("release_required");
    expect(f.urls).toEqual([]);
    unchanged(f);
  }
});

test("a prerelease needs explicit consent even when the tag looks stable", async () => {
  const rc = setup();
  expect(await refusal(rc.run({ allowPrerelease: false }))).toBe("prerelease_not_allowed");
  unchanged(rc);
  const flagged = setup({ release: { tag_name: "v0.3.0", prerelease: true } });
  expect(await refusal(flagged.run({ release: "v0.3.0", allowPrerelease: undefined }))).toBe("prerelease_not_allowed");
  unchanged(flagged);
});

test("tag mismatch, drafts and unverifiable assets are refused", async () => {
  expect(await refusal(setup({ release: { tag_name: "v9.9.9" } }).run())).toBe("release_invalid");
  expect(await refusal(setup({ release: { draft: true } }).run())).toBe("release_invalid");
  const hostile = [
    { browser_download_url: "https://evil.example/tinfoilsh/tinfoil-proxy/releases/download/v0.3.0-rc.8/" + NAME },
    { browser_download_url: url() + "?x=1" },
    { browser_download_url: url("v0.2.9") },
    { browser_download_url: "https://github.com.evil.example/tinfoilsh/tinfoil-proxy/releases/download/v0.3.0-rc.8/" + NAME },
    { browser_download_url: "http://github.com/tinfoilsh/tinfoil-proxy/releases/download/v0.3.0-rc.8/" + NAME },
    { digest: undefined }, { digest: "sha1:abc" }, { size: undefined }, { size: 0 }, { size: 600 * 1024 * 1024 },
  ];
  for (const asset of hostile) {
    const f = setup({ asset });
    expect(await refusal(f.run())).toBe("asset_unverified");
    expect(f.urls.length).toBe(1);
    unchanged(f);
  }
});

test("operator digest and size expectations must match the official metadata", async () => {
  const f = setup();
  expect(await refusal(f.run({ expectedSha256: "0".repeat(64) }))).toBe("expected_digest_mismatch");
  expect(await refusal(f.run({ expectedSize: BODY.length + 1 }))).toBe("expected_size_mismatch");
  unchanged(f);
});

test("digest mismatch, wrong size and oversize bodies leave the installed bytes unchanged", async () => {
  const tampered = setup({ body: new TextEncoder().encode("tampered-binary!") });
  expect(await refusal(tampered.run())).toBe("digest_mismatch");
  unchanged(tampered);
  const short = setup({ body: BODY.slice(0, 4) });
  expect(await refusal(short.run())).toBe("size_mismatch");
  unchanged(short);
  const oversize = setup({ body: new Uint8Array(BODY.length + 100) });
  expect(await refusal(oversize.run())).toBe("oversize");
  unchanged(oversize);
  expect(oversize.probed).toEqual([]);
});

test("a stalled download times out and cleans up", async () => {
  const f = setup({ hang: true });
  expect(await refusal(f.run())).toBe("timeout");
  unchanged(f);
});

test("a probe refusal or incompatible old handshake preserves the installed binary and removes staged files", async () => {
  let staged = "";
  const f = setup({ probe: async (path) => { staged = path; expect(existsSync(path)).toBe(true); throw new Error("legacy ready; no verification"); } });
  expect(await refusal(f.run())).toBe("probe_failed");
  expect(staged).not.toBe("");
  expect(existsSync(staged)).toBe(false);
  unchanged(f);
});

test("success probes the staged bytes privately, then atomically installs and cleans up", async () => {
  const f = setup();
  const result = await f.run();
  expect(result).toEqual({ release: TAG, prerelease: true, path: f.installed, sha256: sha(BODY), size: BODY.length });
  expect(f.probed).toHaveLength(1);
  expect(f.probed[0]!.path).not.toBe(f.installed);
  expect(f.probed[0]!.sha256).toBe(sha(BODY));
  expect(f.probed[0]!.mode).toBe(0o700);
  expect(readFileSync(f.installed)).toEqual(Buffer.from(BODY));
  expect(statSync(f.installed).mode & 0o777).toBe(0o700);
  expect(readdirSync(f.directory)).toEqual(["tinfoil-proxy"]);
});
