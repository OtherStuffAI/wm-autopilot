import { test, expect } from "bun:test";
import { parseStorageOperation } from "./remote-storage-contract";
test("collection protocol admits only exact managed actions and never caller object paths, destinations, headers or methods", () => {
  const id = crypto.randomUUID(),
    hash = "a".repeat(64);
  expect(
    parseStorageOperation(
      { operation: "deletion-preview", set_id: id },
      262144,
    ),
  ).toMatchObject({ set_id: id });
  for (const extra of [
    { url: "https://foreign.invalid" },
    { headers: { Authorization: "x" } },
    { method: "DELETE" },
    { objects: [id] },
    { workspaceId: id },
    { objectId: id },
  ]) {
    expect(() =>
      parseStorageOperation(
        { operation: "deletion-preview", set_id: id, ...extra },
        262144,
      ),
    ).toThrow();
  }
  for (const op of [
    "delete",
    "delete-object",
    "delete-all",
    "collection-delete",
  ])
    expect(() =>
      parseStorageOperation({ operation: op, objectId: id }, 262144),
    ).toThrow();
  expect(() =>
    parseStorageOperation(
      { operation: "deletion-confirm", preview_id: id, digest: hash },
      262144,
    ),
  ).toThrow();
  expect(() =>
    parseStorageOperation(
      {
        operation: "collection-page",
        set_id: id,
        page: 0,
        refs: Array(51).fill({}),
      },
      262144,
    ),
  ).toThrow();
  expect(
    parseStorageOperation(
      { operation: "collection-abort", set_id: id },
      262144,
    ),
  ).toMatchObject({ set_id: id });
});
