import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { renderAgentOptions } from "./agent-options.js";

describe("manual session agent options", () => {
  test("renders Codex as the selected fallback", () => {
    const html = renderAgentOptions("codex");
    expect(html).toContain('<option value="codex" selected>Codex</option>');
    expect(html).toContain('<option value="claude">Claude</option>');
  });

  test("initialises the launcher before the authenticated catalogue arrives", () => {
    const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    expect(appSource).toContain('populateAgentSelect(agentSelect, "codex");');
  });
});
