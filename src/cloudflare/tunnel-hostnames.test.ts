import { describe, expect, test } from "bun:test";

import { CloudflareTunnelClient, createCloudflareTunnelClientFromEnv } from "./tunnel-hostnames";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createClient(fetchImpl: typeof fetch): CloudflareTunnelClient {
  return new CloudflareTunnelClient({
    apiToken: "token",
    accountId: "account",
    tunnelId: "tunnel-1",
    zoneId: "zone",
    fetchImpl,
  });
}

function mockUpsertRequests(initialIngress: Array<Record<string, unknown>>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init: init ?? {} });
    if (href.includes("/configurations") && init?.method === "GET") {
      return jsonResponse({ success: true, result: { config: { ingress: initialIngress } } });
    }
    if (href.includes("/configurations") && init?.method === "PUT") {
      return jsonResponse({ success: true, result: {} });
    }
    if (href.includes("/dns_records?")) {
      return jsonResponse({
        success: true,
        result: [{
          id: "dns-1",
          type: "CNAME",
          name: "other-buzz.agent.example.invalid",
          content: "tunnel-1.cfargotunnel.com",
          proxied: true,
        }],
      });
    }
    throw new Error(`unexpected request: ${href}`);
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

function configuredIngress(calls: Array<{ url: string; init: RequestInit }>): unknown[] {
  const putCall = calls.find((call) => call.init.method === "PUT");
  const body = JSON.parse(String(putCall?.init.body)) as { config: { ingress: unknown[] } };
  return body.config.ingress;
}

describe("createCloudflareTunnelClientFromEnv", () => {
  test("requires all Cloudflare tunnel settings", () => {
    expect(createCloudflareTunnelClientFromEnv({})).toBeNull();
    expect(createCloudflareTunnelClientFromEnv({
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_TUNNEL_ID: "tunnel",
      CLOUDFLARE_ZONE_ID: "zone",
    })).toBeInstanceOf(CloudflareTunnelClient);
  });
});

describe("CloudflareTunnelClient", () => {
  test("upserts ingress before catch-all and creates a proxied CNAME", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init: init ?? {} });
      if (href.includes("/configurations") && init?.method === "GET") {
        return jsonResponse({
          success: true,
          result: {
            config: {
              ingress: [
                { hostname: "agent.example.invalid", service: "http://localhost:3600" },
                { service: "http_status:404" },
              ],
            },
          },
        });
      }
      if (href.includes("/configurations") && init?.method === "PUT") {
        return jsonResponse({ success: true, result: {} });
      }
      if (href.includes("/dns_records?")) {
        return jsonResponse({ success: true, result: [] });
      }
      if (href.endsWith("/dns_records") && init?.method === "POST") {
        return jsonResponse({
          success: true,
          result: {
            id: "dns-1",
            type: "CNAME",
            name: "brandname.com",
            content: "tunnel-1.cfargotunnel.com",
            proxied: true,
          },
        });
      }
      throw new Error(`unexpected request: ${href}`);
    };

    const client = new CloudflareTunnelClient({
      apiToken: "token",
      accountId: "account",
      tunnelId: "tunnel-1",
      zoneId: "zone",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await client.upsertPublicHostname({
      hostname: "BrandName.com",
      serviceUrl: "http://localhost:3600",
    });

    expect(result).toMatchObject({
      hostname: "brandname.com",
      serviceUrl: "http://localhost:3600",
      cnameTarget: "tunnel-1.cfargotunnel.com",
      dnsRecordId: "dns-1",
    });
    const putCall = calls.find((call) => call.init.method === "PUT");
    expect(JSON.parse(String(putCall?.init.body))).toEqual({
      config: {
        ingress: [
          { hostname: "agent.example.invalid", service: "http://localhost:3600" },
          { hostname: "brandname.com", service: "http://localhost:3600" },
          { service: "http_status:404" },
        ],
      },
    });
    const dnsCall = calls.find((call) => call.init.method === "POST");
    expect(JSON.parse(String(dnsCall?.init.body))).toMatchObject({
      type: "CNAME",
      name: "brandname.com",
      content: "tunnel-1.cfargotunnel.com",
      proxied: true,
    });
  });

  test("inserts an exact hostname before a matching wildcard", async () => {
    const { calls, fetchImpl } = mockUpsertRequests([
      { hostname: "*.agent.example.invalid", service: "http://localhost:3256" },
      { service: "http_status:404" },
    ]);

    await createClient(fetchImpl).upsertPublicHostname({
      hostname: "other-buzz.agent.example.invalid",
      serviceUrl: "http://localhost:3035",
    });

    expect(configuredIngress(calls)).toEqual([
      { hostname: "other-buzz.agent.example.invalid", service: "http://localhost:3035" },
      { hostname: "*.agent.example.invalid", service: "http://localhost:3256" },
      { service: "http_status:404" },
    ]);
  });

  test("keeps unrelated host rules stable while moving the exact rule ahead of its wildcard", async () => {
    const { calls, fetchImpl } = mockUpsertRequests([
      { hostname: "first.example.com", service: "http://localhost:4001" },
      { hostname: "*.agent.example.invalid", service: "http://localhost:3256" },
      { hostname: "middle.example.net", service: "http://localhost:4002" },
      { hostname: "other-buzz.agent.example.invalid", service: "http://localhost:3035" },
      { hostname: "last.example.org", service: "http://localhost:4003" },
      { service: "http_status:404" },
    ]);

    await createClient(fetchImpl).upsertPublicHostname({
      hostname: "other-buzz.agent.example.invalid",
      serviceUrl: "http://localhost:3035",
    });

    expect(configuredIngress(calls)).toEqual([
      { hostname: "first.example.com", service: "http://localhost:4001" },
      { hostname: "other-buzz.agent.example.invalid", service: "http://localhost:3035" },
      { hostname: "*.agent.example.invalid", service: "http://localhost:3256" },
      { hostname: "middle.example.net", service: "http://localhost:4002" },
      { hostname: "last.example.org", service: "http://localhost:4003" },
      { service: "http_status:404" },
    ]);
  });

  test("keeps the catch-all last when Cloudflare returns it out of order", async () => {
    const { calls, fetchImpl } = mockUpsertRequests([
      { service: "http_status:404" },
      { hostname: "unrelated.example.com", service: "http://localhost:4001" },
      { hostname: "*.agent.example.invalid", service: "http://localhost:3256" },
    ]);

    await createClient(fetchImpl).upsertPublicHostname({
      hostname: "other-buzz.agent.example.invalid",
      serviceUrl: "http://localhost:3035",
    });

    expect(configuredIngress(calls).at(-1)).toEqual({ service: "http_status:404" });
  });

  test("re-upserts an already ordered exact hostname without duplication or reordering", async () => {
    const ingress = [
      { hostname: "first.example.com", service: "http://localhost:4001" },
      { hostname: "other-buzz.agent.example.invalid", service: "http://localhost:3035" },
      { hostname: "middle.example.net", service: "http://localhost:4002" },
      { hostname: "*.agent.example.invalid", service: "http://localhost:3256" },
      { service: "http_status:404" },
    ];
    const { calls, fetchImpl } = mockUpsertRequests(ingress);

    await createClient(fetchImpl).upsertPublicHostname({
      hostname: "other-buzz.agent.example.invalid",
      serviceUrl: "http://localhost:3035",
    });

    expect(configuredIngress(calls)).toEqual(ingress);
  });

  test("verification reports an exact rule shadowed by an earlier wildcard as inactive", async () => {
    const { fetchImpl } = mockUpsertRequests([
      { hostname: "*.agent.example.invalid", service: "http://localhost:3256" },
      { hostname: "other-buzz.agent.example.invalid", service: "http://localhost:3035" },
      { service: "http_status:404" },
    ]);

    const result = await createClient(fetchImpl).verifyPublicHostname({
      hostname: "other-buzz.agent.example.invalid",
      serviceUrl: "http://localhost:3035",
    });

    expect(result).toMatchObject({
      hasIngress: true,
      hasDnsRecord: true,
      ingressShadowed: true,
      shadowingHostname: "*.agent.example.invalid",
      active: false,
    });
  });

  test("verification accepts a normal unshadowed exact hostname", async () => {
    const { fetchImpl } = mockUpsertRequests([
      { hostname: "other-buzz.agent.example.invalid", service: "http://localhost:3035" },
      { hostname: "*.agent.example.invalid", service: "http://localhost:3256" },
      { service: "http_status:404" },
    ]);

    const result = await createClient(fetchImpl).verifyPublicHostname({
      hostname: "other-buzz.agent.example.invalid",
      serviceUrl: "http://localhost:3035",
    });

    expect(result).toMatchObject({
      hasIngress: true,
      hasDnsRecord: true,
      ingressShadowed: false,
      shadowingHostname: null,
      active: true,
    });
  });

  test("verification fails when httpHostHeader is overridden", async () => {
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/configurations") && init?.method === "GET") {
        return jsonResponse({
          success: true,
          result: {
            config: {
              ingress: [
                {
                  hostname: "brandname.com",
                  service: "http://localhost:3600",
                  originRequest: { httpHostHeader: "agent.example.invalid" },
                },
                { service: "http_status:404" },
              ],
            },
          },
        });
      }
      if (href.includes("/dns_records?")) {
        return jsonResponse({
          success: true,
          result: [
            {
              id: "dns-1",
              type: "CNAME",
              name: "brandname.com",
              content: "tunnel-1.cfargotunnel.com",
              proxied: true,
            },
          ],
        });
      }
      throw new Error(`unexpected request: ${href}`);
    };

    const client = new CloudflareTunnelClient({
      apiToken: "token",
      accountId: "account",
      tunnelId: "tunnel-1",
      zoneId: "zone",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await client.verifyPublicHostname({
      hostname: "brandname.com",
      serviceUrl: "http://localhost:3600",
    });

    expect(result).toMatchObject({
      hasIngress: true,
      hasDnsRecord: true,
      httpHostHeaderOverridden: true,
      active: false,
    });
  });
});
