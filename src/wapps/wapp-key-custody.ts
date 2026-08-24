import { Database } from "bun:sqlite";

import { decryptSettingValue, encryptSettingValue, isEncryptedSettingValue } from "../storage/setting-value-crypto";
import { createWappAppNsec, deriveWappAppNpubFromNsec } from "./app-key";
import type { WappAppKeyMode, WappRecord } from "./types";

export interface StoredWappKey {
  towerBindingId: string | null;
  appNpub: string | null;
  encryptedAppNsec: string | null;
}

export function readWappNsec(
  db: Database,
  id: string,
  column: "app_nsec_encrypted" | "pending_app_nsec_encrypted" = "app_nsec_encrypted",
): string | null {
  const row = db.query(`SELECT ${column} AS encrypted_nsec FROM wapp_records WHERE id = ?`)
    .get(id) as { encrypted_nsec: string | null } | null;
  return row?.encrypted_nsec ? decryptSettingValue(row.encrypted_nsec) : null;
}

function newStoredKey(
  towerBindingId: string,
  mode: WappAppKeyMode | undefined,
  appNsec: string | null | undefined,
): StoredWappKey {
  const nsec = createWappAppNsec(mode, appNsec);
  return {
    towerBindingId,
    appNpub: deriveWappAppNpubFromNsec(nsec),
    encryptedAppNsec: encryptSettingValue(nsec),
  };
}

export function resolveCreateStoredWappKey(input: {
  towerBindingId: string | null;
  mode: WappAppKeyMode | undefined;
  appNsec: string | null | undefined;
  bindingExists: (id: string) => boolean;
}): StoredWappKey {
  if (!input.towerBindingId) {
    if (input.mode === "import" || input.appNsec?.trim()) {
      throw new Error("towerBindingId is required when configuring a WApp app key");
    }
    return { towerBindingId: null, appNpub: null, encryptedAppNsec: null };
  }
  if (!input.bindingExists(input.towerBindingId)) {
    throw new Error(`Unknown WApp Tower binding: ${input.towerBindingId}`);
  }
  return newStoredKey(input.towerBindingId, input.mode, input.appNsec);
}

export function resolveUpdatedStoredWappKey(input: {
  existing: WappRecord;
  towerBindingId: string | null | undefined;
  mode: WappAppKeyMode | undefined;
  appNsec: string | null | undefined;
  bindingExists: (id: string) => boolean;
  existingKeyAvailable: boolean;
}): StoredWappKey {
  const nextBindingId = input.towerBindingId === undefined
    ? input.existing.towerBindingId
    : input.towerBindingId;
  if (!nextBindingId) return { towerBindingId: null, appNpub: null, encryptedAppNsec: null };
  if (!input.bindingExists(nextBindingId)) throw new Error(`Unknown WApp Tower binding: ${nextBindingId}`);
  if (input.existingKeyAvailable) {
    if (input.mode !== undefined || input.appNsec !== undefined) {
      throw new Error("WApp app key replacement is not supported for existing assignments");
    }
    return {
      towerBindingId: nextBindingId,
      appNpub: input.existing.appNpub,
      encryptedAppNsec: null,
    };
  }
  if (input.existing.towerBindingId || input.existing.appNpub) {
    throw new Error("Existing Tower-backed WApp assignment is missing encrypted WAPP_NSEC");
  }
  return newStoredKey(nextBindingId, input.mode, input.appNsec);
}

export function stageWappPublisherKey(
  db: Database,
  id: string,
  mode: WappAppKeyMode | undefined,
  importedNsec: string | null | undefined,
): void {
  const nsec = createWappAppNsec(mode, importedNsec);
  db.query(`
    UPDATE wapp_records
    SET pending_app_npub = ?, pending_app_nsec_encrypted = ?, updated_at = ?
    WHERE id = ?
  `).run(
    deriveWappAppNpubFromNsec(nsec),
    encryptSettingValue(nsec),
    new Date().toISOString(),
    id,
  );
}

export function activateWappPublisherKey(db: Database, id: string): void {
  db.query(`
    UPDATE wapp_records
    SET app_npub = pending_app_npub,
        app_nsec_encrypted = pending_app_nsec_encrypted,
        pending_app_npub = NULL,
        pending_app_nsec_encrypted = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), id);
}

export function ensureWappKeyEncrypted(db: Database, id: string, column: string, value: string | null | undefined): void {
  if (!value || isEncryptedSettingValue(value)) return;
  db.query(`UPDATE wapp_records SET ${column} = ? WHERE id = ?`).run(encryptSettingValue(value), id);
}
