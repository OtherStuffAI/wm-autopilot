import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestDirectory, discoverSkills, resolveAuthorizedDirectory } from "./skill-content";
import type { SkillRevisionRecord, SkillSourceRecord } from "./types";

export class SkillSourceImporter {
  constructor(private readonly snapshotsRoot = new URL("../../data/skill-revisions", import.meta.url).pathname) {}

  async inspect(source: SkillSourceRecord, allowedRoots: string[]) {
    if (source.sourceKind === "local") {
      const root = await resolveAuthorizedDirectory(source.location, allowedRoots);
      const digest = (await digestDirectory(root)).digest;
      return { root, commit: null, digest, cleanup: async () => {} };
    }
    if (!/^https?:\/\//i.test(source.location) && !/^ssh:\/\//i.test(source.location)) throw new Error("Git source must use an HTTPS or SSH URL");
    const temp = await mkdtemp(join(tmpdir(), "wingman-skill-import-"));
    const args = ["-c", "core.hooksPath=/dev/null", "clone", "--no-checkout", "--filter=blob:none"];
    if (source.ref) args.push("--branch", source.ref);
    args.push("--", source.location, temp);
    const clone = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (await clone.exited !== 0) throw new Error(`Git fetch failed: ${(await new Response(clone.stderr).text()).trim()}`);
    const rev = Bun.spawn(["git", "-C", temp, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
    if (await rev.exited !== 0) throw new Error("Git source has no resolvable revision");
    const commit = (await new Response(rev.stdout).text()).trim();
    const checkout = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-C", temp, "checkout", "--detach", commit], { stdout: "pipe", stderr: "pipe" });
    if (await checkout.exited !== 0) throw new Error(`Git checkout failed: ${(await new Response(checkout.stderr).text()).trim()}`);
    const digest = (await digestDirectory(temp)).digest;
    return { root: temp, commit, digest, cleanup: () => rm(temp, { recursive: true, force: true }) };
  }

  async import(source: SkillSourceRecord, allowedRoots: string[]): Promise<{ revisions: SkillRevisionRecord[]; commit: string | null; digest: string }> {
    const inspected = await this.inspect(source, allowedRoots);
    try {
      const hydrated = { ...source, fetchedCommit: inspected.commit };
      return { revisions: await discoverSkills(inspected.root, hydrated, this.snapshotsRoot), commit: inspected.commit, digest: inspected.digest };
    } finally { await inspected.cleanup(); }
  }
}
