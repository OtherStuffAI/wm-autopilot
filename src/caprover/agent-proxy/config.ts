import { nip19 } from "nostr-tools";
import { CaproverClient, createCaproverTargetClientsFromEnv } from "../caprover-client";
import type { CaproverAppDefinition } from "../types";
import { targetNameSchema } from "./validation";

export type AgentCaproverClient = Pick<CaproverClient,
  "getAllApps" | "getApp" | "createApp" | "deployCaptainDefinition" | "patchAppConfig" |
  "addCustomDomain" | "removeCustomDomain" | "enableSslOnDomain" | "enableSsl">;

export interface ProxyConfig {
  allowedNpub: string | null;
  publicOrigin: string | null;
  target: { name: string; client: AgentCaproverClient } | null;
}

export function validNpub(value: string | undefined): string | null {
  try {
    if (!value) return null;
    const decoded = nip19.decode(value);
    return decoded.type === "npub" && nip19.npubEncode(decoded.data) === value ? value : null;
  } catch { return null; }
}

export function validOrigin(value: string | undefined): string | null {
  try {
    if (!value) return null;
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) return null;
    return url.origin;
  } catch { return null; }
}

export function loadProxyConfig(env: Record<string, string | undefined> = process.env): ProxyConfig {
  const name = targetNameSchema.safeParse(env.CAPROVER_AGENT_TARGET);
  const targets = createCaproverTargetClientsFromEnv(env, { timeoutMs: 30_000, rejectRedirects: true });
  const selected = name.success ? targets.find((target) => target.name === name.data) : null;
  let target: ProxyConfig["target"] = null;
  if (selected) {
    try {
      const url = new URL(selected.serverUrl);
      if (url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) {
        target = { name: selected.name, client: selected.client };
      }
    } catch { /* Invalid target configuration leaves access closed. */ }
  }
  return { allowedNpub: validNpub(env.CAPROVER_AGENT_ALLOWED_NPUB), publicOrigin: validOrigin(env.CAPROVER_AGENT_PUBLIC_ORIGIN), target };
}

/** Construct read DTOs explicitly: credentials, env values and arbitrary upstream fields never escape. */
export function appView(app: CaproverAppDefinition) {
  return {
    appName: app.appName,
    hasPersistentData: app.hasPersistentData,
    instanceCount: app.instanceCount,
    containerHttpPort: app.containerHttpPort,
    hasDefaultSubDomainSsl: app.hasDefaultSubDomainSsl,
    notExposeAsWebApp: app.notExposeAsWebApp,
    envKeys: app.envVars.map((variable) => variable.key),
    domains: app.customDomain?.map((domain) => ({ domain: domain.publicDomain, hasSsl: domain.hasSsl })) ?? [],
    volumes: app.volumes.map((volume) => ({ containerPath: volume.containerPath, volumeName: volume.volumeName })),
    ports: app.ports.map((port) => ({ containerPort: port.containerPort, hostPort: port.hostPort, protocol: port.protocol })),
    isAppBuilding: app.isAppBuilding ?? null,
    deployedVersion: app.deployedVersion ?? null,
  };
}
