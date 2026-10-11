import { parseNativeCodexResult } from "./native-codex-result.ts";
import { runIsolatedProject } from "./managed-project.ts";
import type { ProjectExecution } from "./project-profile.ts";
import type { ProjectProvider } from "./provider-policy.ts";
import { nativeCodexCommand } from "./native-codex-command.ts";

export interface IsolatedCodexInput extends Omit<ProjectExecution, "command" | "providerModel"> {
  prompt: string;
  nativeReference?: string;
}

/** Owned integration entrypoint; no existing adapter is changed. Live activation remains separately gated. */
export async function runIsolatedCodex(image: string, input: IsolatedCodexInput, provider: ProjectProvider) {
  const request = { prompt: input.prompt, model: provider.model, nativeReference: input.nativeReference };
  nativeCodexCommand(request, "http://127.0.0.1:1/v1");
  assertPrivateContinuity(input.continuity);
  const result = await runIsolatedProject(image, {
    project: input.project, continuity: input.continuity, durationMs: input.durationMs,
    command: ["bun", "/opt/isolation/native-codex.ts", JSON.stringify(request)],
  }, provider);
  assertPrivateContinuity(result.continuity);
  return { ...result, ...parseNativeCodexResult(result.stdout, input.nativeReference) };
}

function assertPrivateContinuity(files: ProjectExecution["continuity"]): void {
  if (files.some((file) => /(?:^|\/)(?:auth\.json|config\.toml|\.credentials\.json)$/.test(file.path))) {
    throw new Error("Credentials/config are forbidden in native continuity");
  }
}
