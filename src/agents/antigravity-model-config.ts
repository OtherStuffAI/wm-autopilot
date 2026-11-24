import type { AcpProcessClient, AcpResponse } from "./acp-process-client";

type ConfigOption = { id: string; currentValue: string; options: Array<{ value: string }> };
type SessionResult = {
  models?: { currentModelId: string; availableModels: Array<{ modelId: string }> };
  configOptions?: ConfigOption[];
};

export function readAntigravityModel(response: AcpResponse): string | null {
  const result = response.result as SessionResult | undefined;
  if (result?.models?.currentModelId) return result.models.currentModelId;
  const model = result?.configOptions?.find((option) => option.id === "model")?.currentValue;
  const thought = result?.configOptions?.find((option) => option.id === "thought_level")?.currentValue;
  return model ? thought ? `${model}-${thought}` : model : null;
}

/** agy separates the model family and thinking level in its config API. */
export async function configureAntigravityModel(
  client: AcpProcessClient, sessionId: string, response: AcpResponse, requested?: string,
): Promise<AcpResponse | void> {
  if (!requested || requested === "default") return;
  const result = response.result as SessionResult | undefined;
  if (!result?.models?.availableModels?.some((model) => model.modelId === requested)) {
    throw new Error(`Antigravity model ${requested} is not advertised by your authenticated agy account. Refresh the model list; no fallback was used.`);
  }
  const options = result.configOptions ?? [];
  const model = options.find((option) => option.id === "model");
  const thought = options.find((option) => option.id === "thought_level");
  // Prefer an exact family match; otherwise match an advertised family + level.
  const family = model?.options.find((option) => option.value === requested)?.value
    ?? model?.options.find((option) => thought?.options.some((level) => `${option.value}-${level.value}` === requested))?.value;
  const level = family && requested !== family ? requested.slice(family.length + 1) : null;
  if (!family) throw new Error(`Antigravity model ${requested} has no matching ACP configuration.`);
  let selected = response;
  for (const [configId, value] of [["model", family], ...(level ? [["thought_level", level]] : [])]) {
    selected = await client.request("session/set_config_option", { sessionId, configId, value });
    const configured = (selected.result as SessionResult | undefined)?.configOptions;
    if (selected.error || configured?.find((option) => option.id === configId)?.currentValue !== value) {
      throw new Error(`Antigravity could not confirm ${configId}=${value}: ${selected.error?.message ?? "missing or inconsistent ACP configuration"}`);
    }
  }
  // Exact IDs without a thinking suffix (e.g. orchestrators) are already complete.
  if (level && readAntigravityModel(selected) !== requested) {
    throw new Error(`Antigravity did not confirm requested model ${requested}; no fallback was used.`);
  }
  return selected;
}
