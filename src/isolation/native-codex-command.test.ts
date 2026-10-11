import { expect, test } from "bun:test";
import { nativeCodexCommand } from "./native-codex-command.ts";
test("native command uses credential-free loopback and explicit resume", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  const args = nativeCodexCommand({ prompt: "Edit project", model: "fixture-model", nativeReference: id }, "http://127.0.0.1:1234/v1");
  expect(args.slice(-4)).toEqual(["resume", id, "--", "-"]);
  expect(args).toContain("model_providers.isolated.requires_openai_auth=false");
  expect(args).toContain("model_providers.isolated.supports_websockets=false");
  expect(args).toContain("--ignore-user-config");
  expect(args).toContain("--ignore-rules");
  expect(nativeCodexCommand({ prompt: "--help", model: "fixture" }, "http://127.0.0.1:1234/v1").slice(-2)).toEqual(["--", "-"]);
  expect(() => nativeCodexCommand({ prompt: "x", model: "fixture" }, "http://host:3600")).toThrow();
});
