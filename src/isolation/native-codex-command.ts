export interface NativeCodexRequest { prompt: string; model: string; nativeReference?: string; }

export function nativeCodexCommand(request: NativeCodexRequest, baseUrl: string): string[] {
  if (!request.prompt || request.prompt.length > 16000 || !/^[A-Za-z0-9._-]{1,80}$/.test(request.model) ||
    !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(baseUrl) ||
    (request.nativeReference !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.nativeReference))) {
    throw new Error("Invalid isolated native request");
  }
  const args = ["/opt/codex/codex", "exec", "--json", "--cd", "/workspace", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
    "--dangerously-bypass-approvals-and-sandbox", "-c", 'web_search="disabled"', "-c", 'model_provider="isolated"',
    "-c", 'model_providers.isolated.name="Managed project model"',
    "-c", `model_providers.isolated.base_url=${JSON.stringify(baseUrl)}`,
    "-c", 'model_providers.isolated.wire_api="responses"',
    "-c", "model_providers.isolated.requires_openai_auth=false",
    "-c", "model_providers.isolated.supports_websockets=false", "-m", request.model];
  if (request.nativeReference) args.push("resume", request.nativeReference);
  // Send the exact prompt via stdin so participant text cannot become CLI options.
  args.push("--", "-");
  return args;
}
