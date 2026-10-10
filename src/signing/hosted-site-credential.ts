import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SignerError } from "./application-signer";

/** Capture only an opaque grant credential, never the underlying signing key. */
export function captureHostedSiteCredential(directory: string, grantId: string, credential: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new SignerError("credential_directory_unsafe");
  const path = join(directory, `${grantId}.cap`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0) throw new SignerError("credential_file_unsafe");
    writeFileSync(fd, `${credential}\n`); fsyncSync(fd);
    return path;
  } catch (error) { unlinkSync(path); throw error; }
  finally { closeSync(fd); }
}
