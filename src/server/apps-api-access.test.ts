import { describe, expect, test } from "bun:test";

import { AccessActions } from "../auth/access-control";
import { appCommandAccessAction, appRouteAccessAction } from "./apps-api-access";

describe("managed app API access classification", () => {
  test("keeps owner-local app setup separate from infrastructure mutations", () => {
    expect(appRouteAccessAction("PUT", "/api/apps/app-1".split("/"), AccessActions))
      .toBe(AccessActions.AppsSelfManage);
    expect(appRouteAccessAction("POST", "/api/apps/app-1/env/import-dotenv".split("/"), AccessActions))
      .toBe(AccessActions.AppsSelfManage);
    expect(appRouteAccessAction("POST", "/api/apps/app-1/domains".split("/"), AccessActions))
      .toBe(AccessActions.AppsManage);
    expect(appRouteAccessAction("POST", "/api/apps/app-1/caprover/link".split("/"), AccessActions))
      .toBe(AccessActions.AppsManage);
  });

  test("classifies lifecycle, setup, logs, and custody commands narrowly", () => {
    expect(appCommandAccessAction("restart", AccessActions)).toBe(AccessActions.AppsLifecycle);
    expect(appCommandAccessAction("setup", AccessActions)).toBe(AccessActions.AppsSelfManage);
    expect(appCommandAccessAction("clear-logs", AccessActions)).toBe(AccessActions.AppsSelfManage);
    expect(appCommandAccessAction("review-wapp-tower-broker", AccessActions)).toBe(AccessActions.AppsManage);
  });
});
