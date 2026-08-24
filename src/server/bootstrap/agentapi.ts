import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { arch, platform } from "node:os";

export type EnsureAgentApiBinaryOptions = {
  agentApiBinaryPath: string;
  projectRootDirectory: string;
  downloadsJsonPath?: string;
};

const getProvenanceFilePath = (binaryPath: string): string => `${binaryPath}.provenance.json`;

async function verifyLoopbackBuild(binaryPath: string): Promise<boolean> {
  try {
    const [binary, provenanceText] = await Promise.all([
      readFile(binaryPath),
      readFile(getProvenanceFilePath(binaryPath), "utf8"),
    ]);
    const provenance = JSON.parse(provenanceText) as Record<string, unknown>;
    const digest = createHash("sha256").update(binary).digest("hex");
    return provenance.patch === "vendor/agentapi/loopback-listener.patch" && provenance.sha256 === digest;
  } catch {
    return false;
  }
}

export const ensureAgentApiBinary = async ({
  agentApiBinaryPath,
}: EnsureAgentApiBinaryOptions) => {
  const currentPlatform = platform();
  const currentArch = arch();
  console.log(`[agentapi] Detected platform: ${currentPlatform}, architecture: ${currentArch}`);

  if (await verifyLoopbackBuild(agentApiBinaryPath)) {
    console.log("[agentapi] Verified loopback-only Wingman build provenance");
    return;
  }

  throw new Error(
    "[agentapi] Refusing unverified all-interface binary. Run bun run build:agentapi-loopback for this host before starting Autopilot.",
  );
};
