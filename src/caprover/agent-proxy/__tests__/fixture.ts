import { mock } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type { CaproverAppDefinition } from "../../types";
import type { AgentCaproverClient, ProxyConfig } from "../config";

export const secret = generateSecretKey();
export const allowedNpub = nip19.npubEncode(getPublicKey(secret));
export const origin = "https://proxy.example";
export const base = `${origin}/api/agent/caprover`;
export const app: CaproverAppDefinition = {
  appName: "demo", hasPersistentData: true, hasDefaultSubDomainSsl: true,
  containerHttpPort: 80, notExposeAsWebApp: false, instanceCount: 1,
  captainDefinitionRelativeFilePath: "captain-definition", envVars: [{ key: "SECRET", value: "PRIVATE_ENV_VALUE" }],
  volumes: [], ports: [], customDomain: [], isAppBuilding: false, deployedVersion: 1,
  versions: [{ version: 1, timeStamp: "2026-09-28T09:00:00.000Z", deployedImageName: "PRIVATE_IMAGE_VALUE", gitHash: "PRIVATE_GIT_VALUE" }],
  appPushWebhook: { repoInfo: { user: "u", password: "PRIVATE_PASSWORD", sshKey: "PRIVATE_KEY", repo: "r", branch: "b" }, pushWebhookToken: "PRIVATE_WEBHOOK" },
};

export function fixture() {
  const apps = [structuredClone(app)];
  const client = {
    getAllApps: mock(async () => ({ apps, rootDomain: "captain.example" })),
    getApp: mock(async (name: string) => apps.find((item) => item.appName === name) ?? null),
    createApp: mock(async (name: string, persistent?: boolean) => { apps.push({ ...structuredClone(app), appName: name, hasPersistentData: persistent ?? false }); }),
    deployCaptainDefinition: mock(async () => {}),
    patchAppConfig: mock(async () => {}),
    addCustomDomain: mock(async () => {}), removeCustomDomain: mock(async () => {}),
    enableSslOnDomain: mock(async () => {}), enableSsl: mock(async () => {}),
  } satisfies AgentCaproverClient;
  const config: ProxyConfig = { allowedNpub, publicOrigin: origin, target: { name: "primary", client } };
  return { client, apps, config };
}

export function signedRequest(path: string, options: {
  method?: string; body?: string; signedBody?: string; signer?: Uint8Array; signedUrl?: string;
  signedMethod?: string; createdAt?: number; kind?: number; payloadTags?: string[][];
  extraTags?: string[][]; headers?: Record<string, string>; badSignature?: boolean;
} = {}) {
  const method = options.method ?? "GET";
  const url = `${base}${path}`;
  const tags = [["u", options.signedUrl ?? url], ["method", options.signedMethod ?? method], ...(options.extraTags ?? [])];
  if (options.payloadTags) tags.push(...options.payloadTags);
  else if (options.body !== undefined) tags.push(["payload", bytesToHex(sha256(new TextEncoder().encode(options.signedBody ?? options.body)))]);
  const event = finalizeEvent({ kind: options.kind ?? 27235, created_at: options.createdAt ?? Math.floor(Date.now() / 1000), tags, content: crypto.randomUUID() }, options.signer ?? secret);
  if (options.badSignature) event.sig = "0".repeat(128);
  return new Request(url, { method, body: options.body, headers: {
    "content-type": "application/json", authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`, ...options.headers,
  } });
}
