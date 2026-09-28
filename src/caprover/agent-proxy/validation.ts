import { z } from "zod";

export const appNameSchema = z.string().min(1).max(50).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export const targetNameSchema = z.string().min(1).max(50).regex(/^[a-z][a-z0-9-]*$/);
const domainSchema = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const imageSchema = z.string().min(1).max(256).regex(
  /^(?:(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?)\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})?$/,
);
const portSchema = z.number().int().min(1).max(65535);
const envSchema = z.array(z.object({
  key: z.string().max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  value: z.string().max(8192),
}).strict()).max(100).refine((vars) => new Set(vars.map((v) => v.key)).size === vars.length, "Duplicate env keys");
const volumeSchema = z.object({
  containerPath: z.string().max(256).regex(/^\/(?:[A-Za-z0-9_-]+\/?)+$/),
  volumeName: z.string().min(1).max(100).regex(/^[a-z][a-z0-9-]*$/),
}).strict();

export const createSchema = z.object({ appName: appNameSchema, hasPersistentData: z.boolean().optional() }).strict();
export const deploySchema = z.union([
  z.object({ imageName: imageSchema }).strict(),
  z.object({ captainDefinition: z.object({ schemaVersion: z.literal(2), imageName: imageSchema }).strict() }).strict(),
]);
export const configSchema = z.object({
  instanceCount: z.number().int().min(0).max(20).optional(),
  containerHttpPort: portSchema.optional(),
  envVars: envSchema.optional(),
  volumes: z.array(volumeSchema).max(10).optional(),
  forceSsl: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Empty config patch");
export const domainActionSchema = z.object({
  action: z.enum(["add", "remove", "enable-https"]), domain: domainSchema,
}).strict();
export const httpsSchema = z.object({}).strict();

export class ProxyError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const limit = 128 * 1024;
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new ProxyError(413, "Request body too large");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new ProxyError(413, "Request body too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export function parseJson(request: Request, body: Uint8Array): unknown {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    throw new ProxyError(415, "Use application/json");
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
  catch { throw new ProxyError(400, "Invalid JSON body"); }
}
