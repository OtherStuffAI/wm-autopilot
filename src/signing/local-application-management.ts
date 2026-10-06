import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { Database } from "bun:sqlite";
import type { BotKeyRecord } from "../identity/bot-key-store";
import { ApplicationSigner, type ApplicationGrantPolicy } from "./application-signer";
import { BrokerKeyVault } from "./broker-key-vault";

function requireOwnedPath(path: string, directory: boolean, privateMode: boolean): void {
  if (!isAbsolute(path)) throw new Error("local_management_requires_absolute_paths");
  const info = lstatSync(path);
  if (info.uid !== process.getuid?.() || (directory ? !info.isDirectory() : !info.isFile())
    || (!directory && info.nlink !== 1) || (privateMode && (info.mode & 0o077) !== 0)) {
    throw new Error("local_management_unsafe_path");
  }
}

/** Local host administration, not a remote caller or an owner impersonation. */
export async function registerLocalApplication(input: {
  dataDir: string;
  masterKeyPath: string;
  ownerNpub: string;
  botNpub: string;
  expectedPubkey: string;
  policy: ApplicationGrantPolicy;
  credentialFile: string;
}) {
  const botDbPath = join(input.dataDir, "bot-keys.db");
  const grantDbPath = join(input.dataDir, "application-grants.db");
  const envelopesDirectory = join(input.dataDir, "broker-vault", "keys");
  requireOwnedPath(input.dataDir, true, true);
  requireOwnedPath(botDbPath, false, false);
  requireOwnedPath(grantDbPath, false, true);
  requireOwnedPath(dirname(input.masterKeyPath), true, true);
  requireOwnedPath(input.masterKeyPath, false, true);
  requireOwnedPath(envelopesDirectory, true, true);
  requireOwnedPath(dirname(input.credentialFile), true, true);
  if (!isAbsolute(input.credentialFile)) throw new Error("local_management_requires_absolute_paths");

  const db = new Database(botDbPath, { readonly: true });
  const lookup = (npub: string) => db.query<BotKeyRecord, [string]>(`SELECT
    id, user_npub AS userNpub, bot_pubkey_hex AS botPubkeyHex, bot_npub AS botNpub,
    display_name AS displayName, encrypted_to_user AS encryptedToUser,
    encrypted_escrow AS encryptedEscrow, escrow_uuid AS escrowUuid,
    is_active AS isActive, created_at AS createdAt, updated_at AS updatedAt
    FROM bot_keys WHERE bot_npub=? AND is_active=1`).get(npub);
  let vault: BrokerKeyVault | undefined;
  let signer: ApplicationSigner | undefined;
  let fd: number | undefined;
  let grantId: string | undefined;
  try {
    const record = lookup(input.botNpub);
    if (!record || record.userNpub !== input.ownerNpub || record.botPubkeyHex !== input.expectedPubkey) {
      throw new Error("local_management_identity_denied");
    }
    requireOwnedPath(join(envelopesDirectory, `${record.id}.json`), false, true);
    // Preflight forbids the vault constructor's new-master-key path.
    vault = new BrokerKeyVault({ dataDir: input.dataDir, masterKeyPath: input.masterKeyPath, envelopesDirectory });
    signer = new ApplicationSigner(grantDbPath, lookup, vault);
    fd = openSync(input.credentialFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw new Error("local_management_unsafe_credential");
    }
    const result = await signer.registerVerified(record.userNpub, record.botNpub, input.expectedPubkey, input.policy);
    grantId = result.grant.id;
    writeFileSync(fd, `${result.credential}\n`);
    fsyncSync(fd);
    return result.grant;
  } catch (error) {
    if (grantId) signer?.revoke(input.ownerNpub, grantId);
    if (fd !== undefined) unlinkSync(input.credentialFile);
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
    signer?.close();
    vault?.destroy();
    db.close();
  }
}
