const credentialKey = /^(?:authorization|proxyauthorization|cookie|setcookie|password|passphrase|nsec|secret(?:key)?|privatekey|apikey|accesstoken|refreshtoken|callbacktoken|token|bearer|bunkeruri|nwc)$/i;

export function redactPipelineValue(value: unknown, secrets: string[] = []): { value: unknown; redacted: boolean } {
  let redacted = false;
  const knownSecrets = [...secrets];
  function collect(item: unknown): void {
    if (Array.isArray(item)) { item.forEach(collect); return; }
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if ((credentialKey.test(key.replace(/[-_]/g, "")) || /(?:secret|privatekey|apikey|callbacktoken)$/i.test(key.replace(/[-_]/g, ""))) && typeof child === "string" && child) knownSecrets.push(child);
      else collect(child);
    }
  }
  collect(value);
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
      if (credentialKey.test(key.replace(/[-_]/g, "")) || /(?:secret|privatekey|apikey|callbacktoken)$/i.test(key.replace(/[-_]/g, ""))) {
        redacted = true;
        return [key, "[REDACTED]"];
      }
      return [key, visit(child)];
    }));
    return item;
  }
  return { value: visit(value), redacted };
}
