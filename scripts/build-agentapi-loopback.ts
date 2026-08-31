import { resolve } from "node:path";

import { ensureAgentApiBinary } from "../src/server/bootstrap/agentapi";

const projectRootDirectory = resolve(import.meta.dir, "..");
await ensureAgentApiBinary({
  agentApiBinaryPath: resolve(projectRootDirectory, "out", "agentapi"),
  projectRootDirectory,
});
