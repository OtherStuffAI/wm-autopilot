import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tinfoilRunnerEnvironment } from "./runner-config";
import { buildGooseRuntimeEnv } from "../agents/goose-adapter";
import { buildPiAcpRuntimeEnv } from "../agents/pi-acp-adapter";

test("runner configurations use ephemeral token references and preserve existing providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "tinfoil-config-"));
  const runtime = { baseUrl: "http://127.0.0.1:1234/v1", token: "scoped-session-only" };
  try {
    const opencode = await tinfoilRunnerEnvironment("opencode", "kimi-k3-1-pro", runtime, root, {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { openrouter: { models: { "other/model": {} } } } }),
    });
    const config = JSON.parse(opencode.OPENCODE_CONFIG_CONTENT!);
    expect(config.provider.openrouter.models).toHaveProperty("other/model");
    expect(config.provider.tinfoil.options.apiKey).toBe("{env:WINGMAN_MODEL_TOKEN}");
    expect(opencode.OPENCODE_CONFIG_CONTENT).not.toContain(runtime.token);
    const pi = await tinfoilRunnerEnvironment("pi", "kimi-k3-1-pro", runtime, root);
    const piConfig = await readFile(join(pi.PI_CODING_AGENT_DIR!, "models.json"), "utf8");
    expect(piConfig).not.toContain(runtime.token);
    expect(JSON.parse(piConfig).providers.tinfoil.apiKey).toBe("$WINGMAN_MODEL_TOKEN");
    expect(buildPiAcpRuntimeEnv({ id: "test", agent: "pi", port: 1, host: "localhost", env: pi }).PI_CODING_AGENT_DIR).toBe(pi.PI_CODING_AGENT_DIR);
    const goose = await tinfoilRunnerEnvironment("goose", "kimi-k3-1-pro", runtime, root);
    const gooseRuntime = buildGooseRuntimeEnv({ id: "test", agent: "goose", port: 1, host: "localhost", env: goose, model: "kimi-k3-1-pro", gooseCompletedTurn: true });
    expect(gooseRuntime.GOOSE_PROVIDER).toBe("openai");
    expect(gooseRuntime.OPENAI_HOST).toBe("http://127.0.0.1:1234");
    expect(gooseRuntime.OPENAI_BASE_PATH).toBe("v1/chat/completions");
    expect(gooseRuntime.OPENAI_API_KEY).toBe(runtime.token);
  } finally { await rm(root, { recursive: true, force: true }); }
});
