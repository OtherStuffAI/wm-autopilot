import { callCapabilityBroker, type CapabilityClientContext } from "../mcp/capability-client";
import { trustedOrigin } from "../git/native-forgejo-login";

export class NativeForgejoIssueError extends Error {
  readonly code = "forgejo_request_failed";
  constructor(readonly status: number) { super(`Native Forgejo request failed (${status}).`); }
}

export class NativeForgejoIssuesClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly config: { forgejoUrl: string; capabilityContext: CapabilityClientContext; fetchImpl?: typeof fetch }) {
    this.origin = trustedOrigin(config.forgejoUrl);
    if (this.origin !== config.forgejoUrl.replace(/\/$/, "")) throw new Error("Forgejo URL must be an origin.");
    this.fetchImpl = config.fetchImpl ?? config.capabilityContext.fetch ?? fetch;
  }
  async listIssues(repository: string, input: { state: string; page: number; limit: number }): Promise<unknown> {
    return this.request(repository, "GET", `/issues?${new URLSearchParams(Object.entries(input).map(([k,v]) => [k,String(v)] as [string,string]))}`);
  }
  async readIssue(repository: string, number: number): Promise<unknown> { return this.request(repository, "GET", `/issues/${number}`); }
  async createIssue(repository: string, input: { title: string; body: string }): Promise<unknown> { return this.request(repository, "POST", "/issues", input); }
  async commentIssue(repository: string, number: number, input: { body: string }): Promise<unknown> { return this.request(repository, "POST", `/issues/${number}/comments`, input); }
  async listPulls(repository: string): Promise<unknown> { return this.request(repository, "GET", "/pulls"); }
  async readPull(repository: string, number: number): Promise<unknown> { return this.request(repository, "GET", `/pulls/${number}`); }
  async createPull(repository: string, input: { title: string; body: string; head: string; base: string }): Promise<unknown> { return this.request(repository, "POST", "/pulls", input); }

  private async request(repository: string, method: string, suffix: string, body?: unknown): Promise<unknown> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repository)) throw new Error("--repo must be native owner/repository.");
    const parsed = new URL(this.origin);
    for (let attempt = 0; attempt < 2; attempt++) {
      const credential = await callCapabilityBroker<{ username: string; password: string; expiresAt: string }>("/api/mcp/capabilities/git-credential", {
        protocol: parsed.protocol.slice(0,-1), host: parsed.host, path: `${repository}.git`,
      }, this.config.capabilityContext);
      const response = await this.fetchImpl(`${this.origin}/api/v1/repos/${repository}${suffix}`, {
        method, redirect: "error", headers: { authorization: `Bearer ${credential.password}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.ok) return response.json();
      // A new broker request checks /user, dropping only expired/revoked OAuth
      // credentials. Native permission failures (403/404) are final.
      if (response.status === 401 && attempt === 0) continue;
      throw new NativeForgejoIssueError(response.status);
    }
  }
}
