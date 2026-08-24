import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const uiRoot = import.meta.dir;

describe("raw secret export removal", () => {
  test("shipped UI modules contain no bot or WApp private-key export controls", () => {
    const files = [
      "app.js",
      "apps/cards.js",
      "services/apps.js",
      "identity/panels.js",
      "identity/index.js",
      "identity/state-manager.js",
      "nip98/signing-listener.js",
    ];
    const source = files.map((file) => readFileSync(join(uiRoot, file), "utf8")).join("\n");
    for (const forbidden of [
      "/api/bot-keys/admin-nsec",
      "/api/bot-keys/export-nsec",
      "/api/bot-keys/unlock",
      "botkey:decrypt_request",
      "/api/wapps/${encodeURIComponent(wappId)}/nsec",
      "app-card-copy-wapp-nsec",
      "export-bot-nsec",
      "toggle-nsec-visibility",
      "clipboard.writeText(nsec)",
      "nsec-field",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
