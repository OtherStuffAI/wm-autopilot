import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { load as loadYaml } from "js-yaml";

import type { FipsNodeDescriptor } from "./fips-app-ingress-manager";

export const FIPS_NATIVE_VERSION = "0.5.0";
export const FIPS_NATIVE_CONFIG_PATH = "/usr/local/etc/fips/fips.yaml";
export const FIPS_NATIVE_ATTESTATION_PATH = "/usr/local/etc/fips/wingman-poc-runtime.json";
export const FIPS_NATIVE_CTL_PATH = "/usr/local/bin/fipsctl";
export const FIPS_NATIVE_CONTROL_SOCKET = "/var/run/fips/control.sock";
export const FIPS_NATIVE_LAUNCHD_LABEL = "system/com.fips.daemon";
export const FIPS_RENDEZVOUS_APP = "wingman-fips-poc-v1";
export const FIPS_BOOTSTRAP_NPUB = "npub1qmc3cvfz0yu2hx96nq3gp55zdan2qclealn7xshgr448d3nh6lks7zel98";
export const FIPS_BOOTSTRAP_ADDRESS = "217.77.8.91:2121";

type CommandResult = { exitCode: number; stdout: string; stderr: string };
export type NativeFipsCommandRunner = (argv: string[]) => Promise<CommandResult>;

export interface NativeFipsRuntimeOptions {
  configPath?: string;
  attestationPath?: string;
  fipsctlPath?: string;
  controlSocketPath?: string;
  run?: NativeFipsCommandRunner;
  readText?: (path: string) => Promise<string>;
  canExecute?: (path: string) => Promise<boolean>;
}

export interface NativeFipsRuntimeStatus {
  installed: boolean;
  launchdLoaded: boolean;
  configured: boolean;
  ready: boolean;
  version: string | null;
  descriptor: FipsNodeDescriptor | null;
  error: string | null;
}

function safeMessage(input: string): string {
  return input
    .replace(/nsec1[023456789acdefghjklmnpqrstuvwxyz]+/gi, "[redacted-fips-secret]")
    .replace(/\b[0-9a-f]{64}\b/gi, "[redacted-secret]")
    .trim()
    .slice(0, 300);
}

async function defaultRunner(argv: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function configIsCompatible(text: string): boolean {
  let value: unknown;
  try {
    value = loadYaml(text);
  } catch {
    return false;
  }
  if (!value || typeof value !== "object") return false;
  const root = value as Record<string, any>;
  return root.schema === 2
    && root.fipsVersion === FIPS_NATIVE_VERSION
    && root.rendezvousApp === FIPS_RENDEZVOUS_APP
    && root.nostrShareLocalCandidates === true
    && root.lanEnabled === true
    && root.lanScope === FIPS_RENDEZVOUS_APP
    && root.tunEnabled === true
    && root.dnsEnabled === true
    && root.udpAdvertiseOnNostr === true
    && root.udpAcceptConnections === true
    && root.udpOutboundOnly === false
    && root.bootstrapPeerNpub === FIPS_BOOTSTRAP_NPUB
    && root.bootstrapPeerAddress === FIPS_BOOTSTRAP_ADDRESS;
}

function parseDescriptor(stdout: string): FipsNodeDescriptor | null {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const data = parsed.data && typeof parsed.data === "object"
      ? parsed.data as Record<string, unknown>
      : parsed;
    if (String(data.state ?? "").toLowerCase() !== "running"
      || String(data.tun_state ?? "").toLowerCase() !== "active"
      || data.persistent !== true) return null;
    if (typeof data.npub !== "string" || typeof data.ipv6_addr !== "string") return null;
    return { nodeNpub: data.npub, meshAddress: data.ipv6_addr };
  } catch {
    return null;
  }
}

export async function inspectNativeFipsRuntime(
  options: NativeFipsRuntimeOptions = {},
): Promise<NativeFipsRuntimeStatus> {
  const configPath = options.configPath ?? FIPS_NATIVE_CONFIG_PATH;
  const attestationPath = options.attestationPath ?? FIPS_NATIVE_ATTESTATION_PATH;
  const fipsctlPath = options.fipsctlPath ?? FIPS_NATIVE_CTL_PATH;
  const controlSocketPath = options.controlSocketPath ?? FIPS_NATIVE_CONTROL_SOCKET;
  const run = options.run ?? defaultRunner;
  const readText = options.readText ?? ((path) => readFile(path, "utf8"));
  const canExecute = options.canExecute ?? (async (path) => {
    try { await access(path, constants.X_OK); return true; } catch { return false; }
  });
  const base: NativeFipsRuntimeStatus = {
    installed: false,
    launchdLoaded: false,
    configured: false,
    ready: false,
    version: null,
    descriptor: null,
    error: null,
  };

  if (!await canExecute(fipsctlPath)) {
    return { ...base, error: "Native FIPS is not installed; run `bun clis/fips.ts install` from the Autopilot checkout" };
  }
  base.installed = true;
  const version = await run([fipsctlPath, "--version"]);
  base.version = version.exitCode === 0 ? version.stdout.trim() : null;
  if (version.exitCode !== 0 || !base.version?.includes(FIPS_NATIVE_VERSION)) {
    return { ...base, error: `Native FIPS ${FIPS_NATIVE_VERSION} is required${base.version ? `; installed: ${safeMessage(base.version)}` : ""}` };
  }

  const launchd = await run(["/bin/launchctl", "print", FIPS_NATIVE_LAUNCHD_LABEL]);
  if (launchd.exitCode !== 0) {
    return { ...base, error: "FIPS launch daemon is not loaded; run the explicit install/repair command" };
  }
  base.launchdLoaded = true;

  try {
    base.configured = configIsCompatible(await readText(attestationPath));
  } catch {
    base.configured = false;
  }
  if (!base.configured) {
    return { ...base, error: `FIPS config attestation ${attestationPath} is missing or incompatible with ${configPath}; expected ${FIPS_RENDEZVOUS_APP} with same-LAN candidates and authenticated bootstrap, run the explicit install/repair command` };
  }

  const status = await run([fipsctlPath, "--socket", controlSocketPath, "show", "status"]);
  if (status.exitCode !== 0) {
    const detail = safeMessage(status.stderr);
    return { ...base, error: `FIPS daemon is not ready${detail ? `: ${detail}` : ""}` };
  }
  base.descriptor = parseDescriptor(status.stdout);
  if (!base.descriptor) {
    return { ...base, error: "FIPS daemon is not ready: status must report running state, active TUN, persistent identity, public npub, and mesh IPv6 address" };
  }
  base.ready = true;
  return base;
}
