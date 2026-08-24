import { afterEach, describe, expect, test } from "bun:test";

import {
  fetchRemoteInstructTemplate,
  saveRemoteInstructTemplate,
} from "./remote-instruct.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockJsonFetch(status, payload) {
  globalThis.fetch = async () => new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("remote instruct service", () => {
  test("fetches the editable template", async () => {
    mockJsonFetch(200, { template: "Hello $hostname" });

    const result = await fetchRemoteInstructTemplate();

    expect(result.template).toBe("Hello $hostname");
  });

  test("saves the editable template", async () => {
    let body = "";
    globalThis.fetch = async (_url, options) => {
      body = String(options?.body ?? "");
      return new Response(JSON.stringify({ template: "Saved" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await saveRemoteInstructTemplate("Saved");

    expect(JSON.parse(body)).toEqual({ template: "Saved" });
    expect(result.template).toBe("Saved");
  });

  test("uses API message errors when present", async () => {
    mockJsonFetch(503, {
      error: "remote-instruct-not-configured",
      message: "Remote Instruct prompt is not configured",
    });

    await expect(fetchRemoteInstructTemplate()).rejects.toThrow("Remote Instruct prompt is not configured");
  });
});
