import { describe, expect, test } from "bun:test";

import {
  APPS_FILTER_FOCUS_KEY,
  buildAppFilterOptions,
  selectAppCardRenderer,
} from "./apps-view.js";

describe("buildAppFilterOptions", () => {
  test("uses a stable focus key for the app filter input", () => {
    expect(APPS_FILTER_FOCUS_KEY).toBe("apps-filter-input");
  });

  test("returns no options for non-admin viewers", () => {
    const options = buildAppFilterOptions({
      isAdmin: false,
      viewerNpub: "npub1viewer",
      filterOptions: [{ value: "npub1viewer", npub: "npub1viewer", appCount: 2 }],
      abbreviateNpub: (value) => value,
    });

    expect(options).toEqual([]);
  });

  test("prepends the viewer option and deduplicates repeated owners", () => {
    const options = buildAppFilterOptions({
      isAdmin: true,
      viewerNpub: "npub1viewer",
      filterOptions: [
        { value: "npub1viewer", npub: "npub1viewer", appCount: 4 },
        { value: "npub1other", alias: "Alice", appCount: 2 },
        { value: "__anonymous__", appCount: 1 },
      ],
      abbreviateNpub: (value) => `abbr:${value.slice(0, 8)}`,
    });

    expect(options).toEqual([
      { value: "npub1viewer", label: "My apps (abbr:npub1vie)" },
      { value: "all", label: "All apps" },
      { value: "npub1other", label: "Alice • 2 apps" },
      { value: "__anonymous__", label: "Shared • 1 app" },
    ]);
  });
});

describe("Apps card placement", () => {
  test("keeps wingman-core on Apps with its specialised system card", () => {
    const ordinary = () => "ordinary";
    const system = () => "system";
    expect(selectAppCardRenderer({ id: "wingman-core" }, ordinary, system)).toBe(system);
    expect(selectAppCardRenderer({ id: "other-app" }, ordinary, system)).toBe(ordinary);
  });
});
