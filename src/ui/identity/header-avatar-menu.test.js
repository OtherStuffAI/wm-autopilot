import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const indexSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const moduleSource = readFileSync(new URL("./header-avatar-menu.js", import.meta.url), "utf8");

describe("header avatar menu", () => {
  test("uses an identity avatar as the menu toggle", () => {
    expect(indexSource).toContain('id="menu-toggle-avatar"');
    expect(indexSource).toContain('class="wm-menu-toggle-avatar"');
    expect(indexSource).not.toContain('class="menu-icon"');
  });

  test("updates from identity UI state events", () => {
    expect(moduleSource).toContain('applyAvatarImage(avatar, identity.picture, displayName)');
    expect(moduleSource).toContain('"wingman:identity-ui-state"');
  });
});
