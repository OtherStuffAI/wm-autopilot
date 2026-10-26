import { expect, test } from "bun:test";
import type { AppRegistry } from "../../apps/app-registry";
import type { AppProcessManager } from "../../apps/app-process-manager";
import { bootstrapHostedApps } from "./hosted-apps";

test("hosted app recovery stays pending independently and preserves recovery order", async () => {
  const calls: string[] = [];
  const gate = Promise.withResolvers<void>();
  const recovery = bootstrapHostedApps(
    {} as AppRegistry,
    { reconcileFipsIngresses: async () => { calls.push("ingresses"); } } as AppProcessManager,
    { log() {}, warn() {} },
    {
      reconcile: async () => {
        calls.push("reconcile");
        await gate.promise;
        return { appsReconciled: 1, appsCleared: 0 };
      },
      autostart: async () => {
        calls.push("autostart");
        return {} as Awaited<ReturnType<typeof import("./app-autostart").autostartApps>>;
      },
    },
  );
  expect(calls).toEqual(["reconcile"]);
  gate.resolve();
  await recovery;
  expect(calls).toEqual(["reconcile", "autostart", "ingresses"]);
});

test("background recovery reports failures without an unhandled rejection", async () => {
  const warnings: string[] = [];
  await bootstrapHostedApps({} as AppRegistry, {} as AppProcessManager,
    { log() {}, warn: (message) => { warnings.push(message); } },
    {
      reconcile: async () => { throw new Error("PM2 unavailable"); },
      autostart: async () => { throw new Error("must not run after failed reconciliation"); },
    },
  );
  expect(warnings).toEqual(["[apps-bootstrap] app reconciliation or autostart failed: PM2 unavailable"]);
});

test("server starts hosted app recovery after binding HTTP without awaiting it", async () => {
  const source = await Bun.file(new URL("../../server.ts", import.meta.url)).text();
  const call = "void bootstrapHostedApps(appRegistry, appProcessManager);";
  expect(source.indexOf(call)).toBeGreaterThan(source.indexOf("const server = Bun.serve"));
  expect(source).not.toContain("await bootstrapHostedApps(");
});
