import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

// This entrypoint is exclusive to the release-test Docker image. Normal boot
// never imports it, and no authentication or broker policy is replaced.
if (process.env.WINGMAN_ISOLATED_TEST_RUNTIME !== "1" || !existsSync("/.dockerenv") || process.cwd() !== "/app") {
  throw new Error("Isolated test boot requires Docker /app and WINGMAN_ISOLATED_TEST_RUNTIME=1");
}
for (const key of ["WAPP_TOWER_URL", "CONNECT_RELAYS", "WINGMAN_BASE_URL"]) {
  if (!process.env[key]?.trim()) throw new Error(`Isolated test boot requires ${key}`);
}
for (const key of ["WAPP_TOWER_URL", "WINGMAN_BASE_URL"]) {
  const url = new URL(process.env[key]!);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`Isolated test boot requires an HTTP URL without credentials for ${key}`);
  }
}
for (const relay of process.env.CONNECT_RELAYS!.split(",")) {
  const url = new URL(relay.trim());
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Isolated test boot requires explicit WebSocket relay URLs without credentials");
  }
}
for (const key of ["WINGMAN_PRIV", "ADMIN_NPUB", "IDENTITY_SESSION_SECRET"]) {
  if (process.env[key]) throw new Error(`Isolated test boot generates ${key}; do not supply credentials`);
}
process.umask(0o077);
mkdirSync("/app/data/isolated-test", { recursive: true, mode: 0o700 });
const identityPath = "/app/data/isolated-test/bootstrap.json";
if (!existsSync(identityPath)) {
  const key = generateSecretKey();
  writeFileSync(identityPath, JSON.stringify({
    npub: nip19.npubEncode(getPublicKey(key)),
    nsec: nip19.nsecEncode(key),
    cookieSecret: randomBytes(48).toString("base64url"),
  }), { mode: 0o600, flag: "wx" });
  key.fill(0);
}
const identity = JSON.parse(readFileSync(identityPath, "utf8"));
const decoded = nip19.decode(String(identity.nsec));
if (decoded.type !== "nsec" || nip19.npubEncode(getPublicKey(decoded.data)) !== identity.npub || !identity.cookieSecret) {
  throw new Error("Invalid isolated bootstrap identity");
}
decoded.data.fill(0);
Object.assign(process.env, {
  ADMIN_NPUB: identity.npub,
  IDENTITY_SESSION_SECRET: identity.cookieSecret,
  WINGMAN_SETUP_NONINTERACTIVE: "true",
  DEFAULT_AGENT: "pi",
  PI_ACP_CLI: "/app/scripts/isolated-test/deterministic-acp.ts",
  DIRECTORY_DEF: "/workspace",
  FOLDERACCESS: "/workspace",
  AGENT_SPAWN_MODE: "bun",
  AGENT_CHAT_YOKE_CLI_PATH: "/app/node_modules/@runwingman/flightdeck-cli/src/cli.js",
  AGENT_CHAT_YOKE_TRANSLATORS_PATH: "/app/node_modules/@runwingman/flightdeck-cli/src/translators.js",
});
const { FeatureFlagStore } = await import("../../src/storage/feature-flag-store");
const flags = new FeatureFlagStore();
flags.ensureDefaults([{ key: "pi-use-acp", label: "Pi ACP", state: "off" }]);
flags.updateFlag("pi-use-acp", { state: "on", updatedBy: identity.npub });
await import("../../src/index");
