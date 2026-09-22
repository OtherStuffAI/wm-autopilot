import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { SkillRevisionRecord, SkillSourceRecord } from "./types";

const VALID_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IGNORE = new Set([".git", ".DS_Store"]);

export const ensureWithin = (root: string, candidate: string) => {
  const normalizedRoot = resolve(root);
  const normalized = resolve(candidate);
  if (normalized !== normalizedRoot && !normalized.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`Path escapes allowed root: ${candidate}`);
  }
  return normalized;
};

export const digestDirectory = async (root: string): Promise<{ digest: string; files: string[]; executableFiles: string[] }> => {
  const entries: { path: string; data: Buffer; executable: boolean }[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (IGNORE.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const link = await lstat(path);
      if (link.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${relative(root, path)}`);
      if (link.isDirectory()) await visit(path);
      else if (link.isFile()) entries.push({ path: relative(root, path).split(sep).join("/"), data: await readFile(path), executable: (link.mode & 0o111) !== 0 });
      else throw new Error(`Unsupported file type: ${relative(root, path)}`);
    }
  };
  await visit(root);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(entry.path).update("\0").update(entry.data).update("\0");
  return { digest: hash.digest("hex"), files: entries.map((entry) => entry.path), executableFiles: entries.filter((entry) => entry.executable).map((entry) => entry.path) };
};

const parseFrontmatter = (contents: string) => {
  const match = contents.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  if (!match) return { name: "", description: "", error: "SKILL.md requires YAML frontmatter" };
  const field = (name: string) => match[1]?.match(new RegExp(`^${name}:\\s*["']?(.+?)["']?\\s*$`, "m"))?.[1]?.trim() ?? "";
  return { name: field("name"), description: field("description"), error: "" };
};

export const discoverSkills = async (root: string, source: SkillSourceRecord, snapshotRoot: string): Promise<SkillRevisionRecord[]> => {
  const skillFiles: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (IGNORE.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const link = await lstat(path);
      if (link.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${relative(root, path)}`);
      if (link.isDirectory()) await visit(path);
      else if (entry.name === "SKILL.md") skillFiles.push(path);
    }
  };
  await visit(root);
  if (skillFiles.length === 0) throw new Error("No Agent Skills were found (expected SKILL.md)");
  const importedAt = new Date().toISOString();
  const importId = randomUUID();
  const revisions: SkillRevisionRecord[] = [];
  const normalizedNames = new Set<string>();
  for (const file of skillFiles.sort()) {
    const skillRoot = dirname(file);
    const frontmatter = parseFrontmatter(await readFile(file, "utf8"));
    const name = frontmatter.name || basename(skillRoot);
    const errors = frontmatter.error ? [frontmatter.error] : [];
    if (!VALID_NAME.test(name)) errors.push("Skill name must be lower-case kebab-case");
    const collision = name.normalize("NFKC").toLowerCase();
    if (normalizedNames.has(collision)) errors.push("Skill name collides after filesystem normalization");
    normalizedNames.add(collision);
    const content = await digestDirectory(skillRoot);
    const skillId = `${source.id}:${name}`;
    const snapshotPath = join(snapshotRoot, source.id, importId, name);
    await mkdir(dirname(snapshotPath), { recursive: true });
    await cp(skillRoot, snapshotPath, { recursive: true, errorOnExist: true, force: false });
    revisions.push({ id: randomUUID(), importId, sourceId: source.id, skillId, name, description: frontmatter.description, relativePath: relative(root, skillRoot), sourceCommit: source.fetchedCommit, contentDigest: content.digest, compatibility: ["agent-skills", "codex", "goose", "opencode", "pi"], files: content.files, executableFiles: content.executableFiles, warnings: content.executableFiles.length ? [`Contains ${content.executableFiles.length} executable file(s)`] : [], errors, snapshotPath, importedAt, activatedAt: null });
  }
  return revisions;
};

export const atomicCopy = async (source: string, destination: string) => {
  await mkdir(dirname(destination), { recursive: true });
  const staged = `${destination}.wingman-stage-${randomUUID()}`;
  const backup = `${destination}.wingman-backup-${randomUUID()}`;
  try {
    await cp(source, staged, { recursive: true, errorOnExist: true, force: false });
    try { await rename(destination, backup); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rename(staged, destination);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    try { await rename(backup, destination); } catch { /* destination did not previously exist */ }
    throw error;
  }
};

export const appendGitExclude = async (projectRoot: string, paths: string[]) => {
  const git = join(projectRoot, ".git");
  try {
    if (!(await stat(git)).isDirectory()) return;
  } catch { return; }
  const exclude = join(git, "info", "exclude");
  await mkdir(dirname(exclude), { recursive: true });
  let existing = "";
  try { existing = await readFile(exclude, "utf8"); } catch { /* new file */ }
  const additions = paths.filter((path) => !existing.split(/\r?\n/).includes(path));
  if (additions.length) await writeFile(exclude, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${additions.join("\n")}\n`, { mode: 0o600 });
};

export const resolveAuthorizedDirectory = async (input: string, allowedRoots: string[]) => {
  const resolved = await realpath(resolve(input));
  const authorized = await Promise.all(allowedRoots.map(async (root) => { try { return await realpath(resolve(root)); } catch { return resolve(root); } }));
  if (!authorized.some((root) => resolved === root || resolved.startsWith(`${root}${sep}`))) throw new Error("Directory is outside configured filesystem boundaries");
  if (!(await stat(resolved)).isDirectory()) throw new Error("Target is not a directory");
  return resolved;
};
