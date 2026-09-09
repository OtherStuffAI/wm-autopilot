import { expect, test } from "bun:test";
import { flightDeckDocumentBase } from "./flightdeck-document-base";
import type { FlightDeckPgDocumentResult } from "./tower-client";

test("document update uses the exact canonical version and hash from its read", () => {
  const value = { doc: { row_version: 7, storage_object_id: "object" },
    canonical_version: { row_version: 7, storage_object_id: "object", version_id: "doc:7", body_sha256_hex: "a".repeat(64) },
  } as FlightDeckPgDocumentResult;
  expect(flightDeckDocumentBase(value)).toEqual({ baseVersionId: "doc:7", baseBodySha256Hex: "a".repeat(64) });
  expect(() => flightDeckDocumentBase({ ...value, canonical_version: undefined })).toThrow("canonical base");
  expect(() => flightDeckDocumentBase({ ...value, canonical_version: { ...value.canonical_version, row_version: 8 } })).toThrow("canonical base");
});
