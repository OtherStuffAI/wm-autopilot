#!/usr/bin/env bun

import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectNativeFipsRuntime } from "../src/apps/native-fips-runtime";
import {
  buildFipsInstallerOsascriptArgs,
  assertFipsGroupIdAvailable,
  fipsPackageArch,
  verifyBundledFipsPackage,
} from "../src/apps/native-fips-installer";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const command = Bun.argv[2] ?? "status";
const acknowledgement = Bun.argv.includes("--acknowledge-unsigned-upstream-package");

async function run(argv: string[]): Promise<number> {
  const proc = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

async function packagePath(): Promise<string> {
  const arch = fipsPackageArch(process.arch);
  const path = join(root, "vendor", "fips", `fips-0.5.0-macos-${arch}.pkg`);
  try { await access(path, constants.R_OK); } catch {
    throw new Error(`Bundled FIPS package is missing: ${path}. Run bun run fips:prepare:macos.`);
  }
  return realpath(path);
}

async function status(): Promise<number> {
  if (process.platform !== "darwin") {
    console.error("Native FIPS management is supported only on macOS; Linux uses docker-compose.fips.yml.");
    return 1;
  }
  const result = await inspectNativeFipsRuntime();
  console.log(JSON.stringify(result, null, 2));
  return result.ready ? 0 : 1;
}

async function install(): Promise<number> {
  if (process.platform !== "darwin") throw new Error("Native FIPS installation is supported only on macOS.");
  if (!acknowledgement) {
    throw new Error(
      "Upstream FIPS v0.5.0 macOS packages are unsigned and not notarized. "
      + "Autopilot will not weaken Gatekeeper. Inspect the package, then repeat with "
      + "--acknowledge-unsigned-upstream-package to request normal administrator authorization.",
    );
  }
  const pkg = await packagePath();
  await verifyBundledFipsPackage(pkg, process.arch);
  const groupCheck = Bun.spawn(["/usr/bin/dscl", ".", "-search", "/Groups", "PrimaryGroupID", "999"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [groupOutput, groupExit] = await Promise.all([new Response(groupCheck.stdout).text(), groupCheck.exited]);
  if (groupExit !== 0) throw new Error("Could not verify ownership of macOS PrimaryGroupID 999");
  assertFipsGroupIdAvailable(groupOutput);
  const helper = await realpath(join(root, "scripts", "configure-fips-native-macos.sh"));
  console.log("macOS will now request administrator authorization to install/repair FIPS and preserve its existing identity.");
  return run(buildFipsInstallerOsascriptArgs(pkg, helper));
}

if (command === "status") process.exit(await status());
if (command === "prepare") process.exit(await run(["/bin/bash", join(root, "scripts", "prepare-fips-macos.sh"), "--all"]));
if (command === "install" || command === "repair") process.exit(await install());
console.error("Usage: bun clis/fips.ts status|prepare|install|repair [--acknowledge-unsigned-upstream-package]");
process.exit(2);
