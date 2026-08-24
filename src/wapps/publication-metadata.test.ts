import { describe, expect, test } from "bun:test";

import { normalizeRegisteredOpenOrigins } from "./publication-metadata";

describe("WApp publication metadata", () => {
  test("normalizes unique HTTPS origins and derives a safe launch origin", () => {
    expect(normalizeRegisteredOpenOrigins([
      "https://wapp.example/",
      "https://wapp.example",
      "https://admin.wapp.example",
    ])).toEqual(["https://admin.wapp.example", "https://wapp.example"]);
    expect(normalizeRegisteredOpenOrigins(undefined, "https://wapp.example/records/1"))
      .toEqual(["https://wapp.example"]);
  });

  test("rejects non-HTTPS and path-bearing registrations", () => {
    expect(() => normalizeRegisteredOpenOrigins(["http://wapp.example"])).toThrow("HTTPS origins");
    expect(() => normalizeRegisteredOpenOrigins(["https://wapp.example/path"])).toThrow("normalized HTTPS origins");
  });
});
