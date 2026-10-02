const credentialKey = /^(?:authorization|proxyauthorization|cookie|setcookie|password|passphrase|nsec|secret(?:key)?|privatekey|apikey|accesstoken|refreshtoken|callbacktoken|token|bearer|bunkeruri|nwc)$/i;

export function redactPipelineValue(value: unknown, secrets: string[] = []): { value: unknown; redacted: boolean } {
  let redacted = false;
  const knownSecrets = [...pipelineProviderSecrets(), ...secrets];
  knownSecrets.push(...pipelineValueCredentials(value));
  function visit(item: unknown): unknown {
    if (typeof item === "string") {
      let text = item;
      for (const secret of knownSecrets.filter(Boolean)) text = text.split(secret).join("[REDACTED]");
      text = text.replace(/\bnsec1[a-z0-9]+\b/gi, "[REDACTED]")
        .replace(/\b(Bearer\s+)[^\s"\\]+/gi, "$1[REDACTED]")
        .replace(/([?&](?:token|callback_token|api_key|access_token)=)[^&\s"\\]+/gi, "$1[REDACTED]");
      text = text.replace(/("(?:api[_-]?key|private[_-]?key|password|passphrase|callback[_-]?token|access[_-]?token)"\s*:\s*")[^"\n]*(")/gi, "$1[REDACTED]$2");
      if (text !== item) redacted = true;
      return text;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => {
      if (isCredentialKey(key)) {
        redacted = true;
        return [visit(key), "[REDACTED]"];
      }
      return [visit(key), visit(child)];
    }));
    return item;
  }
  return { value: visit(value), redacted };
}

/** Ephemeral capture context only; never persist discovered credential lists. */
export function pipelineValueCredentials(value: unknown): string[] {
  const credentials: string[] = [];
  function collect(item: unknown): void {
    if (Array.isArray(item)) { item.forEach(collect); return; }
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (isCredentialKey(key) && typeof child === "string" && child) credentials.push(child);
      else collect(child);
    }
  }
  collect(value);
  return credentials;
}

/** Only provider credentials already available to execution; never identity keys. */
export function pipelineProviderSecrets(): string[] {
  return ["PIPELINE_CLASSIFIER_OPENROUTER_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_API", "OPENAI_API_KEY", "PIPELINE_MEMORY_EMBEDDING_API_KEY"]
    .map(key => process.env[key]?.trim()).filter((value): value is string => Boolean(value));
}

function isCredentialKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, "");
  return credentialKey.test(normalized) || /(?:secret|privatekey|apikey|callbacktoken)$/i.test(normalized);
}
