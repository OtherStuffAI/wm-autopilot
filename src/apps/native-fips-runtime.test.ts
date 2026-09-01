import { describe, expect, test } from "bun:test";
import { inspectNativeFipsRuntime } from "./native-fips-runtime";

const config = JSON.stringify({ schema: 1, fipsVersion: "0.5.0", rendezvousApp: "wingman-fips-poc-v1", nostrShareLocalCandidates: true, lanEnabled: true, lanScope: "wingman-fips-poc-v1", tunEnabled: true, dnsEnabled: true, udpAdvertiseOnNostr: true, udpAcceptConnections: true, udpOutboundOnly: false });

describe("native FIPS runtime inspection", () => {
  test("returns a public descriptor only after install, launchd, config, and daemon checks", async () => {
    const status = await inspectNativeFipsRuntime({
      canExecute: async () => true,
      readText: async () => config,
      run: async (argv) => {
        if (argv.includes("--version")) return { exitCode: 0, stdout: "fipsctl 0.5.0\n", stderr: "" };
        if (argv.includes("print")) return { exitCode: 0, stdout: "state = running\n", stderr: "" };
        return {
          exitCode: 0,
          stdout: JSON.stringify({ data: { state: "Running", tun_state: "active", persistent: true, npub: "npub1sx42mj99aql52aklsg70y2jmr95u7uz2p40k769aw46ppjv302kqkhmu5r", ipv6_addr: "fd1b:4788:b7ab:7a43:6a61:1fc5:9fb1:e34c" } }),
          stderr: "",
        };
      },
    });
    expect(status).toMatchObject({ installed: true, launchdLoaded: true, configured: true, ready: true });
    expect(status.descriptor?.nodeNpub).toStartWith("npub1");
  });

  test("uses the native control socket instead of the Docker socket", async () => {
    let statusArgs: string[] = [];
    await inspectNativeFipsRuntime({
      canExecute: async () => true,
      readText: async () => config,
      run: async (argv) => {
        if (argv.includes("--version")) return { exitCode: 0, stdout: "fipsctl 0.5.0", stderr: "" };
        if (argv.includes("print")) return { exitCode: 0, stdout: "loaded", stderr: "" };
        statusArgs = argv;
        return { exitCode: 0, stdout: JSON.stringify({ state: "running", tun_state: "active", persistent: true, npub: "npub1sx42mj99aql52aklsg70y2jmr95u7uz2p40k769aw46ppjv302kqkhmu5r", ipv6_addr: "fd1b:4788:b7ab:7a43:6a61:1fc5:9fb1:e34c" }), stderr: "" };
      },
    });
    expect(statusArgs).toEqual(["/usr/local/bin/fipsctl", "--socket", "/var/run/fips/control.sock", "show", "status"]);
  });

  test("fails with an actionable message without an installed binary", async () => {
    const status = await inspectNativeFipsRuntime({ canExecute: async () => false });
    expect(status.ready).toBe(false);
    expect(status.error).toContain("bun clis/fips.ts install");
  });

  test("rejects an incompatible rendezvous namespace without exposing status", async () => {
    let statusCalled = false;
    const status = await inspectNativeFipsRuntime({
      canExecute: async () => true,
      readText: async () => config.replaceAll("wingman-fips-poc-v1", "fips-overlay-v1"),
      run: async (argv) => {
        if (argv.includes("--version")) return { exitCode: 0, stdout: "fipsctl 0.5.0", stderr: "" };
        if (argv.includes("print")) return { exitCode: 0, stdout: "loaded", stderr: "" };
        statusCalled = true;
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    });
    expect(status.ready).toBe(false);
    expect(status.error).toContain("wingman-fips-poc-v1");
    expect(statusCalled).toBe(false);
  });

  test("rejects a config that cannot receive mesh connections", async () => {
    const result = await inspectNativeFipsRuntime({
      canExecute: async () => true,
      readText: async () => config.replace('"udpOutboundOnly":false', '"udpOutboundOnly":true'),
      run: async (argv) => argv.includes("--version")
        ? { exitCode: 0, stdout: "fipsctl 0.5.0", stderr: "" }
        : { exitCode: 0, stdout: "loaded", stderr: "" },
    });
    expect(result.ready).toBe(false);
    expect(result.error).toContain("install/repair");
  });

  test("rejects an attestation that does not enable same-LAN Nostr candidates", async () => {
    const result = await inspectNativeFipsRuntime({
      canExecute: async () => true,
      readText: async () => config.replace('"nostrShareLocalCandidates":true', '"nostrShareLocalCandidates":false'),
      run: async (argv) => argv.includes("--version")
        ? { exitCode: 0, stdout: "fipsctl 0.5.0", stderr: "" }
        : { exitCode: 0, stdout: "loaded", stderr: "" },
    });
    expect(result.ready).toBe(false);
    expect(result.error).toContain("same-LAN candidate sharing");
    expect(result.error).toContain("install/repair");
  });

  test("rejects a daemon without running, active-TUN, persistent status", async () => {
    const result = await inspectNativeFipsRuntime({
      canExecute: async () => true,
      readText: async () => config,
      run: async (argv) => {
        if (argv.includes("--version")) return { exitCode: 0, stdout: "fipsctl 0.5.0", stderr: "" };
        if (argv.includes("print")) return { exitCode: 0, stdout: "loaded", stderr: "" };
        return { exitCode: 0, stdout: JSON.stringify({ state: "starting", tun_state: "configured", persistent: false, npub: "npub1sx42mj99aql52aklsg70y2jmr95u7uz2p40k769aw46ppjv302kqkhmu5r", ipv6_addr: "fd1b:4788:b7ab:7a43:6a61:1fc5:9fb1:e34c" }), stderr: "" };
      },
    });
    expect(result.ready).toBe(false);
    expect(result.error).toContain("active TUN");
    expect(result.descriptor).toBeNull();
  });
});
