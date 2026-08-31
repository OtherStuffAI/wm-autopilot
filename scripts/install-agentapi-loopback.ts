import { resolve } from "node:path";

if (Bun.env.WINGMAN_SKIP_AGENTAPI_INSTALL === "1") {
  console.log("[agentapi] Skipping native install hook for the Docker builder");
} else {
  const { ensureAgentApiBinary } = await import("../src/server/bootstrap/agentapi");
  const projectRootDirectory = resolve(import.meta.dir, "..");
  await ensureAgentApiBinary({
    agentApiBinaryPath: resolve(projectRootDirectory, "out", "agentapi"),
    projectRootDirectory,
  });
}
