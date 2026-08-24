import { describe, expect, test } from "bun:test";

import { getNextProjectSessionName } from "./project-session-launcher.js";

describe("project session launcher helpers", () => {
  test("generates incrementing session names per project", () => {
    const project = { id: "project-a", name: "Alpha" };

    expect(getNextProjectSessionName(project)).toBe("Alpha-1");
    expect(getNextProjectSessionName(project)).toBe("Alpha-2");
    expect(getNextProjectSessionName({ id: "project-b", name: "Beta" })).toBe("Beta-1");
  });
});
