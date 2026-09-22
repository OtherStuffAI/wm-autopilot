import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("Skills page", () => {
  test("is a primary accessible navigation surface with catalogue actions", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const page = readFileSync(new URL("./page.js", import.meta.url), "utf8");
    const components = readFileSync(new URL("./page-components.js", import.meta.url), "utf8");
    const styles = readFileSync(new URL("./page.css", import.meta.url), "utf8");
    expect(html).toContain('data-route="skills"');
    expect(html).toContain('data-testid="nav-skills"');
    expect(page).toContain('main.dataset.testid = "skills-page"');
    expect(page).toContain('data-testid="skills-add-source"');
    expect(page).toContain('dialog.dataset.testid = "skills-source-dialog"');
    expect(page).toContain('aria-live="polite"');
    expect(page).toContain("/api/skills/sources/import");
    expect(page).toContain("Fetching, validating, and importing");
    expect(components).toContain('card.dataset.testid = `skills-source-${source.id}`');
    expect(components).toContain("skill.deployments.length");
    expect(components).toContain("Your catalogue is empty");
    expect(styles).toContain("@media (max-width: 640px)");
    expect(styles).toContain("max-height: calc(100dvh - 2rem)");
    expect(html).toContain('href="/skills/page.css"');
  });
});
