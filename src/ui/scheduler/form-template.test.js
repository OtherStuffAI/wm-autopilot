import { describe, expect, test } from "bun:test";

import { renderTriggerForm } from "./form-template.js";
import { getPageTemplate } from "./list-template.js";

describe("trigger form template", () => {
  test("create and edit share one structure with mode-specific ids", () => {
    const create = renderTriggerForm("create");
    const edit = renderTriggerForm("edit");
    for (const html of [create, edit]) {
      expect(html).toContain("<form");
      expect(html).toContain("novalidate");
      expect(html).toContain('role="radiogroup"');
      expect(html).toContain("When should it run?");
      expect(html).toContain("What should it do?");
    }
    expect(create).toContain('id="scheduler-create-name"');
    expect(edit).toContain('id="scheduler-edit-name"');
    expect(create).not.toContain("scheduler-edit-");
    expect(edit).not.toContain("scheduler-create-");
    expect(create).toContain('@submit.prevent="submitJob()"');
    expect(edit).toContain('@submit.prevent="saveEdit()"');
  });

  test("every labelled field links its help and error text", () => {
    const html = renderTriggerForm("create");
    expect(html).toContain('for="scheduler-create-name"');
    expect(html).toMatch(/aria-describedby="scheduler-create-name-help scheduler-create-name-error"/);
    expect(html).toContain(':aria-invalid="fieldError(false, \'name\')');
    expect(html).toContain('id="scheduler-create-timezone-error"');
  });

  test("cleanup disables the file watcher choice", () => {
    expect(renderTriggerForm("create")).toContain(':disabled="isCleanupAction"');
  });
});

describe("trigger list template", () => {
  const html = getPageTemplate();

  test("exposes search, filters, empty, loading and error states", () => {
    for (const id of ["scheduler-search", "scheduler-filter-status", "scheduler-filter-type", "scheduler-empty", "scheduler-no-matches", "scheduler-loading", "scheduler-sync-error"]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
  });

  test("uses an accessible switch and confirmation instead of bare controls", () => {
    expect(html).toContain('role="switch"');
    expect(html).toContain(":aria-checked");
    expect(html).toContain("askConfirm(job, 'delete')");
    expect(html).toContain("askConfirm(job, 'run')");
    expect(html).not.toContain("confirm(`");
  });
});
