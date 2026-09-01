import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const PACKAGE_SHA256: Record<string, string> = {
  arm64: "3c2252677725a30f4ef68f01935ca6741e57568854d3f71202f2fa90d7239052",
  x86_64: "a7883c71039ff591880c38c2421b361103f2ecf20840a9bd496eda13cb3e24c0",
};

export function fipsPackageArch(arch: string): "arm64" | "x86_64" {
  if (arch === "arm64") return "arm64";
  if (arch === "x64" || arch === "x86_64") return "x86_64";
  throw new Error(`Unsupported macOS architecture: ${arch}`);
}

export async function verifyBundledFipsPackage(path: string, arch: string): Promise<void> {
  const normalized = fipsPackageArch(arch);
  const digest = createHash("sha256").update(await readFile(path)).digest("hex");
  if (digest !== PACKAGE_SHA256[normalized]) {
    throw new Error(`Bundled FIPS package checksum mismatch for ${normalized}; refusing administrator install`);
  }
}

export function buildFipsInstallerOsascriptArgs(pkgPath: string, helperPath: string): string[] {
  const script = [
    "on run argv",
    "set pkgPath to item 1 of argv",
    "set helperPath to item 2 of argv",
    "set commandText to \"/usr/sbin/installer -pkg \" & quoted form of pkgPath & \" -target / && /bin/sh \" & quoted form of helperPath",
    "do shell script commandText with administrator privileges",
    "end run",
  ].join("\n");
  return ["/usr/bin/osascript", "-e", script, "--", pkgPath, helperPath];
}

export function assertFipsGroupIdAvailable(dsclOutput: string): void {
  const owners = dsclOutput.split(/\r?\n/)
    // `dscl -search` prints continuation lines for multi-valued fields. Only
    // a record line contains the owning group followed by the queried field
    // (newer macOS) or the scalar value (older macOS).
    .map((line) => line.match(/^(\S+)\s+(?:PrimaryGroupID\b|999\b)/)?.[1])
    .filter((owner): owner is string => Boolean(owner));
  const collision = owners.find((owner) => owner !== "fips");
  if (collision) {
    throw new Error(
      `Cannot install upstream FIPS safely: macOS PrimaryGroupID 999 is already owned by group ${collision}`,
    );
  }
}
