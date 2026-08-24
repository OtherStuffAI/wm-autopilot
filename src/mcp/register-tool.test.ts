import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { registerWingmanTool } from "./register-tool";

describe("registerWingmanTool", () => {
  test("registers the exact runtime schema through the bounded MCP adapter", () => {
    const registrations: unknown[][] = [];
    const server = {
      registerTool: (...args: unknown[]) => { registrations.push(args); },
    } as never;
    const schema = { message: z.string() };
    const callback = (_params: never) => ({
      content: [{ type: "text" as const, text: "ok" }],
    });

    registerWingmanTool(server, "example", "Example tool", schema, callback);

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.[0]).toBe("example");
    expect(registrations[0]?.[1]).toEqual({
      description: "Example tool",
      inputSchema: schema,
    });
    expect(registrations[0]?.[2]).toBe(callback);
  });
});
