import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("Skills page", () => {
  test("is a primary accessible navigation surface with catalogue actions", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const page = readFileSync(new URL("./page.js", import.meta.url), "utf8");
    expect(html).toContain('data-route="skills"');
    expect(html).toContain('data-testid="nav-skills"');
    expect(page).toContain('main.dataset.testid = "skills-page"');
    expect(page).toContain('aria-label="Register skill source"');
    expect(page).toContain("/api/skills/sources");
    expect(page).toContain("skill.deployments.length");
  });
});
