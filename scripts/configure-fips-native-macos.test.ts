import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fixtureRoot = "";
afterEach(async () => { if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); fixtureRoot = ""; });

describe("native FIPS config transform", () => {
  test("enables shared Nostr and LAN discovery without replacing identity", async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "fips-native-config-"));
    const configPath = join(fixtureRoot, "fips.yaml");
    const plistPath = join(fixtureRoot, "daemon.plist");
    const attestationPath = join(fixtureRoot, "attestation.json");
    await writeFile(configPath, `node:\n  identity:\n    # persistent: true\n    nsec: "nsec1identity-must-remain"\n  rendezvous:\n    # nostr:\n    #   enabled: true\n    #   policy: configured_only\n    #   app: "fips-overlay-v1"\n    #   advertise: true\n    #   share_local_candidates: false\n    # lan:\n    #   enabled: false\n    #   # scope: "old-scope"\ntun:\n  enabled: false\ndns:\n  enabled: false\ntransports:\n  udp:\n    # advertise_on_nostr: true\n    # accept_connections: true\n    # outbound_only: false\n  tcp:\n    bind_addr: "0.0.0.0:8443"\npeers: []\n`);
    await writeFile(plistPath, "plist");
    const proc = Bun.spawn(["/bin/sh", "scripts/configure-fips-native-macos.sh"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, FIPS_CONFIG_PATH: configPath, FIPS_LAUNCHD_PLIST: plistPath, FIPS_ATTESTATION_PATH: attestationPath, FIPS_CONFIG_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    const transformed = await readFile(configPath, "utf8");
    expect(transformed).toContain('nsec: "nsec1identity-must-remain"');
    expect(transformed).toContain('app: "wingman-fips-poc-v1"');
    expect(transformed).toContain('scope: "wingman-fips-poc-v1"');
    expect(transformed).toContain("share_local_candidates: true");
    expect(transformed.match(/share_local_candidates:/g)).toHaveLength(1);
    expect(transformed).toContain("outbound_only: false");
    expect(transformed).toContain('npub: "npub1qmc3cvfz0yu2hx96nq3gp55zdan2qclealn7xshgr448d3nh6lks7zel98"');
    expect(transformed).toContain('addr: "217.77.8.91:2121"');
    expect(await readFile(`${configPath}.pre-wingman-poc`, "utf8")).toContain("fips-overlay-v1");
    const attestation = JSON.parse(await readFile(attestationPath, "utf8"));
    expect(attestation).toMatchObject({ schema: 2, rendezvousApp: "wingman-fips-poc-v1", nostrShareLocalCandidates: true, lanEnabled: true, udpOutboundOnly: false, bootstrapPeerAddress: "217.77.8.91:2121" });
  });
});
