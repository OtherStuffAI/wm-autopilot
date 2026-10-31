import { expect, test } from "bun:test";
import { documentUpdateBase, requireCapturedDocumentBase } from "./document-update-base.ts";

for (const input of [null, {}, { row_version: 0 }, { row_version: 1.5 },
  { row_version: 6, base_version_id: "v6", base_body_sha256_hex: "wrong" }]) {
  test(`reject incomplete captured document base ${JSON.stringify(input)}`, () => {
    expect(() => requireCapturedDocumentBase(input)).toThrow("Fetch and review");
  });
}

test("captured identity remains authoritative even when current metadata is newer", () => {
  const captured = { row_version: 6, base_version_id: "v6", base_body_sha256_hex: "a".repeat(64) };
  expect(documentUpdateBase({ doc: { row_version: 8 } } as any, captured)).toEqual({
    rowVersion: 6, baseVersionId: "v6", baseBodySha256Hex: "a".repeat(64),
  });
});
