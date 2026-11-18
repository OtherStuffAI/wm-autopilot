import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** The builtin completed-turn composition changes when its tool authority changes. */
export function interviewSourceHash(): string {
  const hash = createHash("sha256");
  for (const path of ["source-pins.ts","control-origins.ts","contract.ts","tools.ts","public-fetch.ts","image.ts","attachment.ts","sdk-options.ts","launch.ts","reply.ts", "../claude-adapter.ts", "../claude-sdk-options.ts", "../claude-adapter-context.ts", "../process-manager.ts", "../../sessions/completed-turn-contract.ts", "../../sessions/completed-turn-runtime.ts", "../../sessions/claude-turn-journal.ts", "../../pipelines/completed-turn-function.ts", "../../wapps/pipeline-request-broker.ts", "../../pipelines/result-webhook-http.ts", "../../pipelines/scoped-interview-registration.ts", "../../pipelines/pipeline-runner.ts"]) {
    hash.update(path); hash.update(readFileSync(new URL(path,import.meta.url)));
  }
  return hash.digest("hex");
}
