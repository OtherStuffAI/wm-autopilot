import { describe, expect, test } from "bun:test";
import { assertFipsGroupIdAvailable, buildFipsInstallerOsascriptArgs, fipsPackageArch } from "./native-fips-installer";

describe("native FIPS installer", () => {
  test("passes package and helper as AppleScript argv instead of interpolating paths", () => {
    const argv = buildFipsInstallerOsascriptArgs("/tmp/a package.pkg", "/tmp/helper script.sh");
    expect(argv.slice(-3)).toEqual(["--", "/tmp/a package.pkg", "/tmp/helper script.sh"]);
    expect(argv[2]).not.toContain("/tmp/a package.pkg");
    expect(argv[2]).toContain("quoted form of pkgPath");
  });

  test("maps Bun's x64 architecture name to the upstream package name", () => {
    expect(fipsPackageArch("arm64")).toBe("arm64");
    expect(fipsPackageArch("x64")).toBe("x86_64");
    expect(() => fipsPackageArch("ppc64")).toThrow();
  });

  test("refuses the upstream hard-coded group id when another group owns it", () => {
    expect(() => assertFipsGroupIdAvailable("othergroup 999\n")).toThrow("othergroup");
    expect(() => assertFipsGroupIdAvailable("fips 999\n")).not.toThrow();
    expect(() => assertFipsGroupIdAvailable("")).not.toThrow();
  });
});
