import { arch, platform } from "node:os";

import {
  buildAgentApiLoopback,
  verifyAgentApiLoopbackBuild,
  type AgentApiBuildOptions,
} from "./agentapi-build";

export type EnsureAgentApiBinaryOptions = {
  agentApiBinaryPath: string;
  projectRootDirectory: string;
  downloadsJsonPath?: string;
  buildBinary?: (options: AgentApiBuildOptions) => Promise<void>;
};

export const ensureAgentApiBinary = async ({
  agentApiBinaryPath,
  projectRootDirectory,
  buildBinary = buildAgentApiLoopback,
}: EnsureAgentApiBinaryOptions) => {
  const currentPlatform = platform();
  const currentArch = arch();
  console.log(`[agentapi] Detected platform: ${currentPlatform}, architecture: ${currentArch}`);

  const buildOptions = { agentApiBinaryPath, projectRootDirectory };
  if (await verifyAgentApiLoopbackBuild(buildOptions)) {
    console.log("[agentapi] Verified loopback-only Wingman build provenance");
    return;
  }

  console.log("[agentapi] Verified loopback-only binary is missing or stale; preparing it now");
  await buildBinary(buildOptions);
  if (!await verifyAgentApiLoopbackBuild(buildOptions)) {
    throw new Error("[agentapi] Built AgentAPI binary failed loopback provenance verification");
  }
  console.log("[agentapi] Verified loopback-only Wingman build provenance");
};
