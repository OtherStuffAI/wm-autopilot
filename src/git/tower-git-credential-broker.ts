import type { GitCredentialBrokerAdapter } from "../signing/capability-broker";
import { NativeForgejoLogin, type NativeForgejoServer, type NativeForgejoCredential } from "./native-forgejo-login";

export interface TowerGitCredentialBrokerDependencies {
  servers: NativeForgejoServer[];
  fetch?: typeof globalThis.fetch;
}

// The name remains for installed imports. Tower supplies only authentication;
// configured native hosts, account credentials and repository access are Forgejo's.
export class TowerGitCredentialBroker implements GitCredentialBrokerAdapter {
  private readonly fetchImpl: typeof fetch;
  // Process-private, actor + origin keyed storage. Restart discards credentials.
  // Nothing is written to disk, agent env, remote URLs or logs.
  private readonly credentials = new Map<string, NativeForgejoCredential>();
  private readonly pending = new Map<string, Promise<NativeForgejoCredential>>();

  constructor(private readonly deps: TowerGitCredentialBrokerDependencies) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    for (const server of deps.servers) new NativeForgejoLogin(server, this.fetchImpl);
    if (new Set(deps.servers.map(server => server.origin)).size !== deps.servers.length) throw new Error("Duplicate native Forgejo origin configuration.");
  }

  async discover(): Promise<{ gatewayOrigins: string[] }> {
    return { gatewayOrigins: this.deps.servers.map(server => server.origin).sort() };
  }

  async exchange(input: Parameters<GitCredentialBrokerAdapter['exchange']>[0]): Promise<NativeForgejoCredential> {
    const server = this.deps.servers.find(candidate => candidate.origin === input.request.gatewayOrigin);
    if (!server) throw new Error("Native Forgejo host is not configured.");
    const key = `${input.botNpub}\0${server.origin}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const operation = this.obtain(key, server, input.signNip98);
    this.pending.set(key, operation);
    try { return await operation; } finally { this.pending.delete(key); }
  }

  private async obtain(key: string, server: NativeForgejoServer, sign: Parameters<NativeForgejoLogin['login']>[0]): Promise<NativeForgejoCredential> {
    const cached = this.credentials.get(key);
    if (cached && Date.parse(cached.expiresAt) > Date.now() + 1000) {
      const response = await this.fetchImpl(`${server.origin}/api/v1/user`, {
        redirect: "error", headers: { authorization: `Bearer ${cached.password}` },
      });
      if (response.ok) return cached;
      // Only an authentication failure discards the credential. Permission
      // denials/network failures never trigger a login loop.
      if (response.status !== 401) throw new Error(`Forgejo account validation failed (${response.status}).`);
    }
    this.credentials.delete(key);
    const credential = await new NativeForgejoLogin(server, this.fetchImpl).login(sign);
    this.credentials.set(key, credential);
    return credential;
  }
}

export function nativeForgejoServersFromEnv(raw: string | undefined): NativeForgejoServer[] {
  if (!raw?.trim()) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some(item => !item || ['origin','towerIssuer','sourceName','clientId','redirectUri'].some(key => typeof item[key] !== 'string' || !item[key]))) throw new Error("WINGMAN_FORGEJO_SERVERS must be an array of native OAuth server configurations.");
  return parsed;
}
