import { homedir } from "node:os";
import { join } from "node:path";

const sensitiveName = /(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|PRIVKEY|NSEC|API_KEY|ACCESS_KEY|CREDENTIAL|COOKIE|AUTH)/i;

function collectNames(value: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectNames(item, names);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (sensitiveName.test(key)) names.add(key);
      collectNames(item, names);
    }
  }
  return names;
}

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await Bun.file(path).text()); } catch { return null; }
}

const pm2Home = Bun.env.PM2_HOME ?? join(homedir(), ".pm2");
const dumpPath = join(pm2Home, "dump.pm2");
const live = Bun.spawnSync(["pm2", "jlist"], { stdout: "pipe", stderr: "pipe" });
const liveJson = live.exitCode === 0 ? JSON.parse(live.stdout.toString()) : null;
const dumpJson = await readJson(dumpPath);
console.log(JSON.stringify({
  live_sensitive_key_names: [...collectNames(liveJson)].sort(),
  dump_sensitive_key_names: [...collectNames(dumpJson)].sort(),
  values_included: false,
}, null, 2));

if (process.argv.includes("--scrub-dump")) {
  const result = Bun.spawnSync(["pm2", "cleardump"], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) process.exit(result.exitCode);
  console.log("PM2 saved dump cleared. Existing daemon/process metadata is unchanged; recreate it from a minimal operator environment.");
}
