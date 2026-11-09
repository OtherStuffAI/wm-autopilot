import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ProviderRuntime { baseUrl: string; token: string }
export async function tinfoilRunnerEnvironment(runner: string, model: string, runtime: ProviderRuntime, directory: string,
  previous: Record<string, string> = {}): Promise<Record<string, string>> {
  const env = { ...previous };
  // Only the revocable session credential enters runner configuration.
  env.WINGMAN_MODEL_PROVIDER = "tinfoil";
  env.WINGMAN_MODEL_TOKEN = runtime.token;
  if (runner === "opencode") {
    const existing = JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}");
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...existing, share: "disabled", provider: {
      ...existing.provider, tinfoil: { npm: "@ai-sdk/openai-compatible", name: "Tinfoil", options: {
        baseURL: runtime.baseUrl, apiKey: "{env:WINGMAN_MODEL_TOKEN}",
      }, models: { [model]: { name: model, limit: { context: 256000, output: 65536 } } } },
    } });
  } else if (runner === "pi") {
    const agentDir = join(directory, "pi-provider");
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { tinfoil: {
      baseUrl: runtime.baseUrl, api: "openai-completions", apiKey: "$WINGMAN_MODEL_TOKEN", authHeader: true,
      models: [{ id: model, name: model, reasoning: true, input: ["text"], contextWindow: 256000, maxTokens: 65536,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" } }],
    } } }), { mode: 0o600 });
    env.PI_CODING_AGENT_DIR = agentDir;
  } else if (runner === "goose") {
    env.GOOSE_PROVIDER = "openai";
    env.GOOSE_DISABLE_KEYRING = "1";
    env.GOOSE_MODEL = model;
    env.OPENAI_API_KEY = runtime.token;
    env.OPENAI_HOST = runtime.baseUrl.replace(/\/v1$/, "");
    env.OPENAI_BASE_PATH = "v1/chat/completions";
  } else throw new Error("tinfoil_runner_unsupported");
  return env;
}
