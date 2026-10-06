import type { AcpProcessClient, AcpResponse } from "./acp-process-client";

type ModelOption = { currentValue?: string; options?: Array<{ value?: string; options?: Array<{ value?: string }> }> };

function readModel(response: AcpResponse): ModelOption | undefined {
  const result = response.result as { configOptions?: Array<ModelOption & { id?: string }> } | undefined;
  return result?.configOptions?.find((option) => option.id === "model");
}

/** DSH uses opaque JSON [provider, model] values and grouped ACP select options. */
export async function configureDeepSeekModel(
  client: AcpProcessClient, sessionId: string, response: AcpResponse, requested?: string,
): Promise<AcpResponse | void> {
  if (!requested || requested === "default") return;
  const option = readModel(response);
  const values = (option?.options ?? []).flatMap((entry) => entry.options ?? [entry]).map((entry) => entry.value);
  const value = values.find((candidate) => candidate === requested || candidate === JSON.stringify(["deepseek-official", requested]));
  if (!value) throw new Error(`DeepSeek Harness model ${requested} is not advertised by the installed runtime/provider. Use default or a model available to your DeepSeek account.`);
  const selected = await client.request("session/set_config_option", { sessionId, configId: "model", value });
  if (selected.error || readModel(selected)?.currentValue !== value) {
    throw new Error("DeepSeek Harness could not confirm the selected model. Verify provider authentication and model access.");
  }
  return selected;
}
