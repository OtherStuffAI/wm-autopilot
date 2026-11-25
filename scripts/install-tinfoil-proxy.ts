import { parseArgs } from "node:util";
import { installTinfoilProxy, TinfoilInstallError } from "../src/model-providers/tinfoil-installer";

// Explicit operator install; the running service never downloads executable code.
const { values } = parseArgs({
  options: {
    release: { type: "string" },
    "allow-prerelease": { type: "boolean", default: false },
    sha256: { type: "string" },
    size: { type: "string" },
  },
});
if (!values.release) {
  console.error("Usage: bun scripts/install-tinfoil-proxy.ts --release <tag> [--allow-prerelease] [--sha256 <hex>] [--size <bytes>]\nAn explicit release tag is required; there is no latest or default.");
  process.exit(2);
}
try {
  const result = await installTinfoilProxy({
    release: values.release,
    allowPrerelease: values["allow-prerelease"],
    expectedSha256: values.sha256,
    expectedSize: values.size === undefined ? undefined : Number(values.size),
  });
  console.log(`Installed Tinfoil proxy ${result.release}${result.prerelease ? " (prerelease)" : ""} at ${result.path}; ${result.size} bytes`);
  console.log(`TINFOIL_PROXY_SHA256=${result.sha256}`);
} catch (error) {
  console.error(error instanceof TinfoilInstallError ? `Install refused: ${error.code}` : "Install failed");
  process.exit(1);
}
