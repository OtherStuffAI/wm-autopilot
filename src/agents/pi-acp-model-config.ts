import type { AcpProcessClient, AcpResponse } from "./acp-process-client";

interface PiModelOption {
  currentValue: string | null;
  values: string[];
}

export interface PiModelIdentifier {
  provider: string;
  modelId: string;
}

export function parsePiModelIdentifier(value: string): PiModelIdentifier | null {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return null;
  return {
    provider: value.slice(0, separator),
    modelId: value.slice(separator + 1),
  };
}

export async function configureAdvertisedPiModel(
  client: AcpProcessClient,
  sessionId: string,
  sessionResponse: AcpResponse,
  requestedModel: string | undefined,
): Promise<void> {
  const model = requestedModel?.trim();
  if (!model) return;

  const identifier = parsePiModelIdentifier(model);
  if (!identifier) {
    throw new Error(
      `Pi ACP model "${model}" must use a provider/model identifier; model IDs may contain additional "/" segments`,
    );
  }

  const advertised = readPiModelOption(sessionResponse);
  if (!advertised || !advertised.values.includes(model)) {
    throw unsupportedPiModelError(model, identifier.provider, advertised?.values ?? []);
  }

  const response = await client.request("session/set_config_option", {
    sessionId,
    configId: "model",
    value: model,
  });
  if (response.error) {
    const detail = readAcpErrorDetail(response.error.data);
    const reason = detail ?? response.error.message ?? "unknown error";
    throw new Error(
      `Pi ACP could not select advertised model "${model}": ${reason}. Verify provider authentication and model access`,
    );
  }

  const confirmed = readPiModelOption(response);
  if (!confirmed || confirmed.currentValue !== model) {
    throw new Error(
      `Pi ACP did not confirm selected model "${model}" after session/set_config_option`,
    );
  }
}

function readPiModelOption(response: AcpResponse): PiModelOption | null {
  const result = asRecord(response.result);
  const configOptions = result?.configOptions;
  if (!Array.isArray(configOptions)) return null;
  const modelOption = configOptions
    .map(asRecord)
    .find((option) => option?.id === "model");
  if (!modelOption) return null;
  const options = Array.isArray(modelOption.options) ? modelOption.options : [];
  const values = options
    .map(asRecord)
    .map((option) => typeof option?.value === "string" ? option.value.trim() : "")
    .filter(Boolean);
  return {
    currentValue: typeof modelOption.currentValue === "string" ? modelOption.currentValue.trim() : null,
    values,
  };
}

function unsupportedPiModelError(model: string, provider: string, advertised: string[]): Error {
  const providerPrefix = `${provider}/`;
  const providerModelCount = advertised.filter((value) => value.startsWith(providerPrefix)).length;
  if (providerModelCount === 0) {
    return new Error(
      `Pi ACP model "${model}" is not advertised by this session; provider "${provider}" is not authenticated or exposes no models. Configure provider authentication in Autopilot/Pi and retry`,
    );
  }
  return new Error(
    `Pi ACP model "${model}" is not advertised by this session (${providerModelCount} ${provider} models available). The model is unavailable in the installed Pi catalog or provider account`,
  );
}

function readAcpErrorDetail(value: unknown): string | null {
  const record = asRecord(value);
  const detail = record?.details;
  return typeof detail === "string" && detail.trim() ? detail.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
