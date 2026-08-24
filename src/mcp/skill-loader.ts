/**
 * Skill Loader — filesystem logic for loading agent skill files
 *
 * Skills are markdown files with optional YAML frontmatter stored at:
 *   1. User skills:    ~/.wingmen/skills/<app>/<name>.md  (overrides)
 *   2. Default skills: <projectRoot>/skills/<app>/<name>.md
 *
 * When both exist for the same app/name, the user version wins.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillEntry {
  app: string;
  name: string;
  description: string;
  source: "user" | "default";
}

export interface SkillContent extends SkillEntry {
  content: string;
}

// ---------------------------------------------------------------------------
// Frontmatter parser (no external deps)
// ---------------------------------------------------------------------------

const FRONTMATTER_DELIM = "---";

export function parseFrontmatter(raw: string): {
  metadata: Record<string, string>;
  content: string;
} {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith(FRONTMATTER_DELIM)) {
    return { metadata: {}, content: raw };
  }

  const afterFirst = trimmed.indexOf("\n");
  if (afterFirst === -1) {
    return { metadata: {}, content: raw };
  }

  const closingIdx = trimmed.indexOf(
    `\n${FRONTMATTER_DELIM}`,
    afterFirst + 1,
  );
  if (closingIdx === -1) {
    return { metadata: {}, content: raw };
  }

  const yamlBlock = trimmed.slice(afterFirst + 1, closingIdx);
  const content = trimmed.slice(closingIdx + 1 + FRONTMATTER_DELIM.length).trimStart();

  const metadata: Record<string, string> = {};
  for (const line of yamlBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) {
      metadata[key] = value;
    }
  }

  return { metadata, content };
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function isValidSegment(segment: string): boolean {
  if (!segment) return false;
  if (segment.includes("/") || segment.includes("\\")) return false;
  if (segment === "." || segment === "..") return false;
  if (segment.includes("..")) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Directory scanning
// ---------------------------------------------------------------------------

async function scanSkillsDir(
  root: string,
  source: "user" | "default",
  appFilter?: string,
): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];

  let appDirs: string[];
  if (appFilter) {
    if (!isValidSegment(appFilter)) return [];
    appDirs = [appFilter];
  } else {
    try {
      const dirEntries = await readdir(root, { withFileTypes: true });
      appDirs = dirEntries.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  }

  for (const app of appDirs) {
    const appDir = join(root, app);
    let files: string[];
    try {
      const dirEntries = await readdir(appDir);
      files = dirEntries.filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }

    for (const file of files) {
      const name = file.slice(0, -3); // strip .md
      try {
        const raw = await readFile(join(appDir, file), "utf-8");
        const { metadata } = parseFrontmatter(raw);
        entries.push({
          app,
          name,
          description: metadata.description ?? "",
          source,
        });
      } catch {
        entries.push({ app, name, description: "", source });
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listSkills(
  userRoot: string,
  defaultRoot: string,
  app?: string,
): Promise<SkillEntry[]> {
  const [userSkills, defaultSkills] = await Promise.all([
    scanSkillsDir(userRoot, "user", app),
    scanSkillsDir(defaultRoot, "default", app),
  ]);

  // User skills override defaults with same app/name
  const seen = new Set<string>();
  const merged: SkillEntry[] = [];

  for (const skill of userSkills) {
    const key = `${skill.app}/${skill.name}`;
    seen.add(key);
    merged.push(skill);
  }

  for (const skill of defaultSkills) {
    const key = `${skill.app}/${skill.name}`;
    if (!seen.has(key)) {
      merged.push(skill);
    }
  }

  return merged.sort((a, b) =>
    a.app === b.app ? a.name.localeCompare(b.name) : a.app.localeCompare(b.app),
  );
}

export async function loadSkill(
  userRoot: string,
  defaultRoot: string,
  app: string,
  name: string,
): Promise<SkillContent | null> {
  if (!isValidSegment(app) || !isValidSegment(name)) {
    return null;
  }

  const filename = `${name}.md`;

  // Try user dir first, then default
  for (const [root, source] of [
    [userRoot, "user"],
    [defaultRoot, "default"],
  ] as const) {
    const filepath = join(root, app, filename);
    try {
      const raw = await readFile(filepath, "utf-8");
      const { metadata, content } = parseFrontmatter(raw);
      return {
        app,
        name,
        description: metadata.description ?? "",
        source,
        content,
      };
    } catch {
      continue;
    }
  }

  return null;
}
