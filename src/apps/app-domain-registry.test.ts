import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import {
  AppDomainConflictError,
  AppDomainRegistry,
  normalizeAppHostname,
} from "./app-domain-registry";

function createRegistry(): AppDomainRegistry {
  const dir = mkdtempSync(join(tmpdir(), "app-domains-"));
  return new AppDomainRegistry(join(dir, "app-domains.json"));
}

describe("normalizeAppHostname", () => {
  test("normalizes protocol, port, path, case, and trailing dot", () => {
    expect(normalizeAppHostname("HTTPS://BrandName.COM:443/path")).toBe("brandname.com");
    expect(normalizeAppHostname("www.BrandName.com.")).toBe("www.brandname.com");
  });

  test("rejects unsafe or unsupported hostnames", () => {
    expect(normalizeAppHostname("localhost")).toBeNull();
    expect(normalizeAppHostname("127.0.0.1")).toBeNull();
    expect(normalizeAppHostname("*.brandname.com")).toBeNull();
    expect(normalizeAppHostname("bad_name.brandname.com")).toBeNull();
    expect(normalizeAppHostname("singlelabel")).toBeNull();
  });
});

describe("AppDomainRegistry", () => {
  test("registers and lists domains by app id", async () => {
    const registry = createRegistry();
    const record = await registry.registerDomain({
      hostname: "BrandName.com",
      appId: "app-1",
    });

    expect(record.hostname).toBe("brandname.com");
    expect(record.status).toBe("pending_dns");
    expect(await registry.getByHostname("brandname.com")).toMatchObject({
      hostname: "brandname.com",
      appId: "app-1",
    });
    expect(await registry.listByAppId("app-1")).toHaveLength(1);
  });

  test("updates status and verification timestamp", async () => {
    const registry = createRegistry();
    await registry.registerDomain({ hostname: "brandname.com", appId: "app-1" });

    const updated = await registry.updateDomain("brandname.com", {
      status: "active",
      verified: true,
      error: null,
    });

    expect(updated.status).toBe("active");
    expect(updated.lastVerifiedAt).toBeTruthy();
    expect(updated.error).toBeNull();
  });

  test("rejects conflicting app ownership", async () => {
    const registry = createRegistry();
    await registry.registerDomain({ hostname: "brandname.com", appId: "app-1" });

    await expect(registry.registerDomain({
      hostname: "brandname.com",
      appId: "app-2",
    })).rejects.toBeInstanceOf(AppDomainConflictError);
  });

  test("removes all domains for an app", async () => {
    const registry = createRegistry();
    await registry.registerDomain({ hostname: "brandname.com", appId: "app-1" });
    await registry.registerDomain({ hostname: "www.brandname.com", appId: "app-1" });

    expect(await registry.removeByAppId("app-1")).toBe(2);
    expect(await registry.listByAppId("app-1")).toEqual([]);
    expect(await registry.getByHostname("brandname.com")).toBeUndefined();
  });
});
