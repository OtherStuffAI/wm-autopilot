import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const sessionsStoreSource = readFileSync(new URL("./sessions/store.js", import.meta.url), "utf8");
const appsStoreSource = readFileSync(new URL("./apps/store.js", import.meta.url), "utf8");
const nightWatchStoreSource = readFileSync(new URL("./nightwatch/store.js", import.meta.url), "utf8");
const schedulerStoreSource = readFileSync(new URL("./scheduler/store.js", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");

describe("bootstrap sync contract", () => {
  test("sessions store supports deferred initial sync", () => {
    expect(sessionsStoreSource).toContain("syncOnInit = true");
    expect(sessionsStoreSource).toContain("if (syncOnInit) {");
    expect(sessionsStoreSource).toContain("void this.sync();");
  });

  test("apps store supports deferred initial sync", () => {
    expect(appsStoreSource).toContain("syncOnInit = true");
    expect(appsStoreSource).toContain("if (syncOnInit) {");
    expect(appsStoreSource).toContain("void this.sync();");
  });

  test("protected startup stores support deferred initial sync", () => {
    expect(nightWatchStoreSource).toContain("syncOnInit = true");
    expect(nightWatchStoreSource).toContain("if (syncOnInit) {");
    expect(schedulerStoreSource).toContain("syncOnInit = true");
    expect(schedulerStoreSource).toContain("if (syncOnInit) {");
  });

  test("app bootstrap defers store sync until auth restoration completes", () => {
    expect(appSource).toContain("initSessionsStore({");
    expect(appSource).toContain("initAppsStore({");
    expect(appSource).toContain("initNightWatchStore({");
    expect(appSource).toContain("initSchedulerStore({");
    expect(appSource).toContain("syncOnInit: false");
    expect(appSource).toContain("syncAuthenticatedStartupStores()");
  });
});
