import { existsSync, readFileSync } from "node:fs";
import { nip19, finalizeEvent, getPublicKey } from "nostr-tools";
if (Bun.env.WINGMAN_ISOLATED_TEST_RUNTIME !== "1" || !existsSync("/.dockerenv")) throw new Error("Isolated administrator signer only");
const identity = JSON.parse(readFileSync("/app/data/isolated-test/bootstrap.json", "utf8"));
const key = nip19.decode(String(identity.nsec));
if (key.type !== "nsec") throw new Error("Invalid generated identity");
try {
  if (Bun.argv[2] === "public") process.stdout.write(getPublicKey(key.data));
  else {
    const event = JSON.parse(await Bun.stdin.text());
    const tag = (name: string) => event.tags.find((row: string[]) => row[0] === name)?.[1];
    const target = new URL(tag("u"));
    if (event.kind !== 27235 || tag("method") !== "POST" || tag("purpose") !== "wingman-login"
      || target.origin !== new URL(Bun.env.WINGMAN_BASE_URL!).origin || target.pathname !== "/api/auth/session"
      || !tag("challenge") || event.content !== tag("challenge")) throw new Error("Only the test UI login challenge is allowed");
    process.stdout.write(JSON.stringify(finalizeEvent(event, key.data)));
  }
} finally { key.data.fill(0); }
