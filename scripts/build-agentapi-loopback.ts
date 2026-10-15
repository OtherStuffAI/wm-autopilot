import { resolve } from "node:path";

import { buildAgentApiLoopback } from "../src/server/bootstrap/agentapi-build";

const projectRootDirectory = resolve(import.meta.dir, "..");
await buildAgentApiLoopback({
  agentApiBinaryPath: resolve(projectRootDirectory, "out", "agentapi"),
  projectRootDirectory,
});
