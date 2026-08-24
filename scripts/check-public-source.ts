import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (args: string[]): string => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout;
};

const trackedFiles = git(["ls-files", "-z"]).split("\0").filter(Boolean);
const failures = new Set<string>();
const runtimeArtifact = /^(?:tmp|scratch|uploads|logs)\/|(?:^|\/)(?:\.mcp\.json|mcp\.json|ecosystem(?:\.[^.\/]+)*\.cjs|ecosystem\.generated\.[^\/]+|pm2[^\/]*\.json|dump\.pm2)$|\.(?:db|sqlite|sqlite3)(?:[-.].*)?$|\.(?:log|pid|pid\.lock|bak|backup)$/i;

const prohibitedMarkers = [
  { label: "operator identity", pattern: /\b(?:Pete|Rick|wm21|wingman21)\b/i },
  {
    label: "operator username",
    pattern: /(?:["'/]mini(?:["'/]|@users\.noreply\.github\.com|-gitea\b)|\bMini User\b)/i,
  },
  { label: "operator home path", pattern: /\/Users\/mini\b/i },
  { label: "private owner", pattern: /\b(?:humansinstitute|honest-ivory-thicket)\b/i },
  { label: "private domain", pattern: /\b(?:otherstuff\.[a-z0-9.-]+|(?:pete|rick)[.-][a-z0-9.-]*runwingman\.com)\b/i },
  { label: "bespoke workflow", pattern: /\b(?:Intelligence Snacks|Marginal Gains|Optikon)\b/i },
];

// Hashes identify the previously published operator npubs without reproducing them here.
const prohibitedNpubHashes = new Set([
  "1a087392b1768ee6656f33dd98f96467cccf4a5d5d03e159d1734e1d4646391b",
  "1c9989c90a2b0f618729d87f3495c42b69d3635b229ddcd271a391f80425c944",
  "7345f8f886169d727bfd149d25db2ff8163cc9ef3d6dbc53a5d8ef1b31f00cfa",
  "8cb73f60939c05d1cc72d3669c33e8e15b34af0f433fbce172f3bbc95a1b6c7a",
  "ab4edad600380d4f2c20113c6171efc2f81474398fab5f20df98afb3c8677113",
  "f64547f941e653a5de22dc04188334667aeefa7efa78fecebba1a0a3b3e01905",
]);
const npubPattern = /npub1[023456789acdefghjklmnpqrstuvwxyz]{58}/g;

for (const file of trackedFiles) {
  if (runtimeArtifact.test(file)) failures.add(`${file}: tracked private/runtime artifact`);
  if (file.startsWith("data/") && !file.endsWith("/.gitkeep")) {
    failures.add(`${file}: tracked generated data`);
  }
  if (file === "scripts/check-public-source.ts") continue;

  const content = readFileSync(file);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  for (const marker of prohibitedMarkers) {
    if (marker.pattern.test(text)) failures.add(`${file}: prohibited ${marker.label}`);
  }
  for (const npub of text.match(npubPattern) ?? []) {
    const hash = createHash("sha256").update(npub).digest("hex");
    if (prohibitedNpubHashes.has(hash)) failures.add(`${file}: prohibited operator npub`);
  }
}

const ignoredTracked = git(["ls-files", "-ci", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
for (const file of ignoredTracked) failures.add(`${file}: tracked despite ignore rules`);

if (failures.size > 0) {
  console.error("Public-source quality check failed:\n" + [...failures].map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Public-source quality check passed (${trackedFiles.length} tracked files checked).`);
