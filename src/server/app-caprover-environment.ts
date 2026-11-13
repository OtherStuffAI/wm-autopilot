import { z } from "zod";
import type { AppsApiContext } from "./apps-api-routes";
import { readBoundedBody, parseJson, ProxyError } from "../caprover/agent-proxy/validation";

const name = z.string().max(50).regex(/^[a-z][a-z0-9-]*$/);
const envKey = z.string().max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const variables = z.array(z.object({
  key: envKey,
  value: z.string().max(32768),
}).strict()).max(128).refine((entries) => new Set(entries.map((entry) => entry.key)).size === entries.length);
const inputSchema = z.object({
  caproverName: name,
  caproverTarget: name.refine((value) => value !== "all"),
  expectedServerUrl: z.string().url(),
  expectedDomain: z.string().max(253).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]+$/),
  envVars: variables.refine((entries) => entries.length > 0),
  unsetKeys: z.array(envKey).max(128).refine((keys) => new Set(keys).size === keys.length).default([]),
}).strict().refine((input) => !input.envVars.some((entry) => input.unsetKeys.includes(entry.key)));

// Serialize read/merge/write operations for each target; no secret-bearing state is retained.
const mutations = new Map<string, Promise<unknown>>();
async function serialize<T>(key: string, action: () => Promise<T>): Promise<T> {
  const next = (mutations.get(key) ?? Promise.resolve()).then(action);
  const tail = next.catch(() => undefined);
  mutations.set(key, tail);
  try { return await next; }
  finally { if (mutations.get(key) === tail) mutations.delete(key); }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** Called only after the central app ACL; owner-space supplies its resource-filtered context. */
export async function mergeAppCaproverEnvironment(request: Request, appId: string, ctx: AppsApiContext): Promise<Response> {
  try {
    const app = await ctx.appRegistry.getApp(appId);
    if (!app || !ctx.canAccessApp(app)) return json({ error: "Not found" }, 404);
    if (!app.webApp) return json({ error: "A registered web app is required" }, 400);
    const parsed = inputSchema.safeParse(parseJson(request, await readBoundedBody(request)));
    if (!parsed.success) return json({ error: "Invalid protected environment merge request" }, 400);
    const input = parsed.data;
    const tracked = ctx.caproverStore.getAppByLocalAppId(appId);
    if (!tracked || tracked.caproverName !== input.caproverName) {
      return json({ error: "Registered CapRover app does not match" }, 409);
    }
    const targets = ctx.createCaproverTargetClientsFromEnv().filter((target) => target.name === input.caproverTarget);
    if (targets.length !== 1 || targets[0]!.serverUrl !== input.expectedServerUrl) {
      return json({ error: "Exact configured CapRover target does not match" }, 409);
    }
    const target = targets[0]!;
    return await serialize(`${target.serverUrl}/${input.caproverName}`, async () => {
      const remote = await target.client.getApp(input.caproverName);
      if (!remote || remote.appName !== input.caproverName) return json({ error: "Target app not found" }, 404);
      if (!remote.customDomain?.some((domain) => domain.publicDomain === input.expectedDomain)) {
        return json({ error: "Target app domain does not match" }, 409);
      }
      // Missing, malformed or duplicate upstream state is not an empty environment.
      const current = variables.safeParse(remote.envVars);
      if (!current.success) return json({ error: "Target environment is unavailable or inconsistent" }, 502);
      const merged = new Map(current.data.map((entry) => [entry.key, entry.value]));
      for (const key of input.unsetKeys) merged.delete(key);
      for (const entry of input.envVars) merged.set(entry.key, entry.value);
      await target.client.patchAppConfig(input.caproverName, {
        envVars: Array.from(merged, ([key, value]) => ({ key, value })),
      });
      return json({ success: true, appId, caproverName: input.caproverName, caproverTarget: target.name });
    });
  } catch (error) {
    if (error instanceof ProxyError) return json({ error: "Invalid protected environment request body" }, error.status);
    // Parser/upstream errors can contain submitted values, existing secrets or credentials.
    return json({ error: "Protected environment merge failed; target partial-config PATCH is required; no fallback attempted" }, 502);
  }
}
