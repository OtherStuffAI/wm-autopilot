import { expect, test } from "bun:test";
import { randomId } from "./random-id.js";
import { createProjectStaticAssetService } from "../../server/static-assets";

test("mesh UI IDs need only getRandomValues, preserve UUID bits and fail without crypto", () => {
  const provider = { getRandomValues: (bytes: Uint8Array) => bytes.fill(255) };
  expect(randomId(provider)).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  expect(randomId()).not.toBe(randomId());
  expect(() => randomId({})).toThrow();
});

test("the browser serves the new ID module as JavaScript", () => {
  const service = createProjectStaticAssetService(new URL("../../../", import.meta.url).pathname);
  expect(service.resolveUiAsset("/core/random-id.js")?.headers.get("content-type")).toContain("application/javascript");
});
