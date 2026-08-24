import { describe, expect, test } from "bun:test";

import { buildPermissionActions } from "./permission-actions.js";

describe("permission actions", () => {
  test("shows only ACP actions backed by runtime option IDs", () => {
    expect(buildPermissionActions({
      options: [
        { optionId: "runtime-once", label: "Allow once", response: "once" },
        { optionId: "runtime-reject", label: "Reject", response: "reject" },
      ],
    })).toEqual([
      { optionId: "runtime-once", label: "Allow once", response: "once", testId: "permission-allow-once" },
      { optionId: "runtime-reject", label: "Reject", response: "reject", testId: "permission-reject" },
    ]);
  });

  test("preserves legacy non-ACP permission actions when options are absent", () => {
    expect(buildPermissionActions({})).toHaveLength(3);
  });
});
