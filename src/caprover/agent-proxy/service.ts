import { ZodError } from "zod";
import { verifyNip98Request, type Nip98ReplayCache } from "../../auth/nip98-verifier";
import { appView, type ProxyConfig } from "./config";
import { CaproverClientError } from "../caprover-client";
import {
  appNameSchema, configSchema, createSchema, deploySchema, domainActionSchema, httpsSchema,
  parseJson, ProxyError, readBoundedBody,
} from "./validation";

import type { ProxyOperationLog } from "./operation-log";

const prefix = "/api/agent/caprover";
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/** One instance per origin; every instance must share the durable replay database. */
export function createAgentCaproverHandler(config: ProxyConfig, replayCache: Nip98ReplayCache, operationLog: ProxyOperationLog) {
  // Serialize mutations to prevent proxy callers from racing config/domain/deploy operations.
  let mutationTail: Promise<unknown> = Promise.resolve();
  async function mutate(appName: string, operation: string, action: () => Promise<Response>): Promise<Response> {
    const next = mutationTail.then(async () => {
      const id = operationLog.start(appName, operation);
      try {
        const response = await action();
        operationLog.finish(id, "completed");
        return response;
      } catch (error) {
        operationLog.finish(id, "outcome-unknown");
        throw error;
      }
    });
    mutationTail = next.catch(() => undefined);
    return next;
  }
  return async function handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const ready = Boolean(config.allowedNpub && config.publicOrigin && config.target);
      if (url.pathname === "/health" && request.method === "GET" && !url.search) {
        return json({ service: "caprover-agent-proxy", ready }, ready ? 200 : 503);
      }
      if (!ready) throw new ProxyError(503, "Proxy configuration incomplete");
      if ((request.headers.get("authorization")?.length ?? 0) > 16384) throw new ProxyError(401, "Invalid NIP-98 authorization");
      const bytes = await readBoundedBody(request);
      const verifiedRequest = new Request(request.url, {
        method: request.method, headers: request.headers,
        body: bytes.length ? bytes : undefined,
      });
      const auth = await verifyNip98Request({
        request: verifiedRequest, requestUrl: url, configuredBaseUrl: config.publicOrigin!,
        replayCache, allowedSignerNpub: config.allowedNpub!,
      });
      if (!auth) throw new ProxyError(401, "Invalid NIP-98 authorization");
      if (url.search) throw new ProxyError(400, "Query parameters are unsupported");
      if (!["GET", "POST", "PATCH"].includes(request.method)) throw new ProxyError(405, "Unsupported method");
      if (request.method === "GET" && bytes.length) throw new ProxyError(400, "GET body is unsupported");
      if (!url.pathname.startsWith(`${prefix}/`)) throw new ProxyError(404, "Unknown route");
      const parts = url.pathname.slice(prefix.length + 1).split("/");
      const target = config.target!;
      const client = target.client;
      if (parts.length === 1 && parts[0] === "target" && request.method === "GET") {
        const result = await client.getAllApps();
        return json({ target: target.name, connected: true, appCount: result.apps.length });
      }
      if (parts.length === 1 && parts[0] === "apps") {
        if (request.method === "GET") return json({ target: target.name, apps: (await client.getAllApps()).apps.map(appView) });
        if (request.method === "POST") {
          const input = createSchema.parse(parseJson(request, bytes));
          return await mutate(input.appName, "create", async () => {
            if (await client.getApp(input.appName)) throw new ProxyError(409, "App already exists");
            await client.createApp(input.appName, input.hasPersistentData ?? false);
            return json({ appName: input.appName, created: true }, 201);
          });
        }
        throw new ProxyError(405, "Unsupported method");
      }
      if (parts[0] !== "apps" || ![2, 3].includes(parts.length)) throw new ProxyError(404, "Unknown route");
      const appName = appNameSchema.parse(parts[1]);
      const operation = parts[2];
      if (request.method === "GET" && (!operation || ["status", "logs", "deployments"].includes(operation))) {
        const app = await client.getApp(appName);
        if (!app) throw new ProxyError(404, "App not found");
        if (!operation) return json({ target: target.name, app: appView(app) });
        if (operation === "deployments") {
          if (!Array.isArray(app.versions)) throw new ProxyError(502, "Target does not provide deployment history");
          return json({ deployments: app.versions.slice(-100).map((version) => {
            if (!Number.isSafeInteger(version.version) || !/^\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?$/.test(version.timeStamp)) {
              throw new ProxyError(502, "Target returned invalid deployment history");
            }
            return { version: version.version, timeStamp: version.timeStamp };
          }) });
        }
        if (typeof app.isAppBuilding !== "boolean") throw new ProxyError(502, "Target does not provide build status");
        return json({ appName, isAppBuilding: app.isAppBuilding, deployedVersion: app.deployedVersion ?? null,
          ...(operation === "logs" ? { logs: operationLog.list(appName), withheld: true, reason: "Raw build/runtime output may contain secrets" } : {}),
        });
      }
      const expected = operation === "config" ? "PATCH" : "POST";
      if (!["config", "deploy", "domains", "https"].includes(operation ?? "")) throw new ProxyError(404, "Unknown route");
      if (request.method !== expected) throw new ProxyError(405, "Unsupported method");
      const body = parseJson(request, bytes);
      // Validate the entire operation before contacting CapRover or changing any state.
      const input = operation === "config" ? configSchema.parse(body)
        : operation === "deploy" ? deploySchema.parse(body)
        : operation === "domains" ? domainActionSchema.parse(body) : httpsSchema.parse(body);
      const volumes = operation === "config" ? configSchema.parse(input).volumes : undefined;
      if (volumes) {
        if (volumes.some((volume) => !volume.volumeName.startsWith(`${appName}-`))) {
          throw new ProxyError(400, "Volume names must start with the app name followed by a hyphen");
        }
        if (new Set(volumes.map((volume) => volume.containerPath)).size !== volumes.length) {
          throw new ProxyError(400, "Duplicate volume container paths");
        }
      }
      return await mutate(appName, operation!, async () => {
        const app = await client.getApp(appName);
        if (!app) throw new ProxyError(404, "App not found");
        if (operation === "config") {
          const patch = configSchema.parse(input);
          if (patch.volumes && !app.hasPersistentData) throw new ProxyError(409, "App was not created with persistent data");
          if (patch.forceSsl === true && !app.hasDefaultSubDomainSsl) throw new ProxyError(409, "Enable default-domain HTTPS before forceSsl");
          await client.patchAppConfig(appName, patch);
        } else if (operation === "deploy") {
          const deploy = deploySchema.parse(input);
          await client.deployCaptainDefinition(appName, "imageName" in deploy ? { schemaVersion: 2, imageName: deploy.imageName } : deploy.captainDefinition);
        } else if (operation === "domains") {
          const domain = domainActionSchema.parse(input);
          if (domain.action === "add") await client.addCustomDomain(appName, domain.domain);
          else if (domain.action === "remove") await client.removeCustomDomain(appName, domain.domain);
          else await client.enableSslOnDomain(appName, domain.domain);
        } else await client.enableSsl(appName);
        return json({ appName, operation, accepted: true });
      });
    } catch (error) {
      if (error instanceof ProxyError) return json({ error: error.message }, error.status);
      // Zod and upstream messages can echo secrets from input; never serialize them.
      if (error instanceof ZodError) return json({ error: "Invalid request fields", fields: error.issues.map((issue) => issue.path.join(".")) }, 400);
      if (error instanceof CaproverClientError && [404, 405, 501].includes(error.statusCode ?? 0) && new URL(request.url).pathname.endsWith("/config")) {
        return json({ error: "Target does not support the required partial-config PATCH; no POST fallback was attempted" }, 502);
      }
      return json({ error: "CapRover operation failed; inspect the target using its trusted administrator interface" }, 502);
    }
  };
}
