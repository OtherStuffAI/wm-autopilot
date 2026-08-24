import { describe, expect, test } from "bun:test";

import { parseDelimitedRows } from "./preview-renderers.js";

describe("file preview renderers", () => {
  test("parseDelimitedRows handles quoted CSV values", () => {
    const rows = parseDelimitedRows('name,notes\nAda,"hello, world"\nGrace,"quote ""inside"""');

    expect(rows).toEqual([
      ["name", "notes"],
      ["Ada", "hello, world"],
      ["Grace", 'quote "inside"'],
    ]);
  });

  test("parseDelimitedRows handles TSV values", () => {
    const rows = parseDelimitedRows("name\tcount\nAda\t2", "\t");

    expect(rows).toEqual([
      ["name", "count"],
      ["Ada", "2"],
    ]);
  });
});
