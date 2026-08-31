import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { parseLegacyWappCustodyMigrationArgs } from "./migrate-legacy-wapp-custody";

const npub = () => {
  const secret = generateSecretKey();
  return nip19.npubEncode(getPublicKey(secret));
};

describe("legacy WApp custody migration CLI", () => {
  test("builds a dry-run request containing metadata but no signing secret", () => {
    const appNpub = npub();
    const owner = npub();
    const creator = npub();
    const parsed = parseLegacyWappCustodyMigrationArgs([
      "app-1",
      "--source-env-file", "/apps/kindling/.env",
      "--expected-app-npub", appNpub,
      "--installation-id", "installation-1",
      "--title", "Kindling API",
      "--installation-owner-npub", owner,
      "--created-by-npub", creator,
      "--workspace-owner-npub", owner,
      "--scope-id", "scope-1",
      "--allowed-npub", owner,
      "--allowed-npub", creator,
      "--launch-url", "https://kindling.example/api",
      "--tower-binding-id", "tower-1",
      "--auto-start", "false",
    ]);
    expect(parsed.input).toMatchObject({
      appId: "app-1",
      expectedAppNpub: appNpub,
      apply: false,
      autoStart: false,
      installation: { allowedNpubs: [owner, creator] },
    });
    expect(JSON.stringify(parsed.input)).not.toContain("nsec1");
  });

  test("has no flag that accepts WAPP_NSEC", () => {
    expect(() => parseLegacyWappCustodyMigrationArgs([
      "app-1",
      "--wapp-nsec", "nsec1must-not-be-accepted",
    ])).toThrow("Unknown option: --wapp-nsec");
  });
});
