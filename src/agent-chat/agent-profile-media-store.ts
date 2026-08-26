import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const MAX_AGENT_PROFILE_MEDIA_BYTES = 5 * 1024 * 1024;

export type AgentProfileMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface VerifiedAgentProfileMedia {
  bytes: Uint8Array;
  digest: string;
  contentType: AgentProfileMediaType;
  size: number;
}

export interface AgentProfileMediaRecord extends VerifiedAgentProfileMedia {
  createdAt: string;
}

export interface AgentProfileMediaOwner {
  agentId: string;
  botNpub: string;
  managerNpub: string;
}

export interface AgentProfileMediaOwnerRecord extends AgentProfileMediaOwner {
  createdAt: string;
}

export class AgentProfileMediaValidationError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'AgentProfileMediaValidationError';
  }
}

const DEFAULT_DB_PATH = new URL('../../data/agent-profile-media.db', import.meta.url).pathname;
const CONTENT_TYPES = new Set<AgentProfileMediaType>(['image/jpeg', 'image/png', 'image/webp']);

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 45 || !signature.every((value, index) => bytes[index] === value)) return false;
  let offset = 8;
  let chunkIndex = 0;
  let hasImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = readUint32Be(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const type = ascii(bytes, offset + 4, 4);
    const expectedCrc = readUint32Be(bytes, offset + 8 + length);
    const actualCrc = crc32(bytes.subarray(offset + 4, offset + 8 + length));
    if (expectedCrc !== actualCrc) return false;
    if (chunkIndex === 0) {
      if (type !== 'IHDR' || length !== 13) return false;
      if (readUint32Be(bytes, offset + 8) === 0 || readUint32Be(bytes, offset + 12) === 0) return false;
    }
    if (type === 'IDAT') hasImageData = true;
    if (type === 'IEND') return length === 0 && hasImageData && end === bytes.length;
    offset = end;
    chunkIndex += 1;
  }
  return false;
}

function isJpeg(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return false;
  let offset = 2;
  let hasFrame = false;
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || marker === 0xd9) return false;
    if (marker === 0xda) return hasFrame && offset + 2 <= bytes.length - 2;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length - 2) return false;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length - 2) return false;
    if (frameMarkers.has(marker)) {
      if (length < 7) return false;
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      if (width === 0 || height === 0) return false;
      hasFrame = true;
    }
    offset += length;
  }
  return false;
}

function isWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return false;
  if (readUint32Le(bytes, 4) !== bytes.length - 8) return false;
  let offset = 12;
  let hasImage = false;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = readUint32Le(bytes, offset + 4);
    const dataOffset = offset + 8;
    const end = dataOffset + length;
    const paddedEnd = end + (length % 2);
    if (end > bytes.length || paddedEnd > bytes.length) return false;
    if (type === 'ANIM' || type === 'ANMF') return false;
    if (type === 'VP8 ') {
      if (length < 10 || bytes[dataOffset + 3] !== 0x9d || bytes[dataOffset + 4] !== 0x01 || bytes[dataOffset + 5] !== 0x2a) return false;
      const width = ((bytes[dataOffset + 7]! << 8) | bytes[dataOffset + 6]!) & 0x3fff;
      const height = ((bytes[dataOffset + 9]! << 8) | bytes[dataOffset + 8]!) & 0x3fff;
      if (width === 0 || height === 0) return false;
      hasImage = true;
    } else if (type === 'VP8L') {
      if (length < 5 || bytes[dataOffset] !== 0x2f) return false;
      hasImage = true;
    } else if (type === 'VP8X') {
      if (length !== 10 || (bytes[dataOffset]! & 0x02) !== 0) return false;
    }
    offset = paddedEnd;
  }
  return hasImage && offset === bytes.length;
}

function detectContentType(bytes: Uint8Array): AgentProfileMediaType | null {
  if (isPng(bytes)) return 'image/png';
  if (isJpeg(bytes)) return 'image/jpeg';
  if (isWebp(bytes)) return 'image/webp';
  return null;
}

export function verifyAgentProfileMedia(
  input: Uint8Array,
  declaredContentType: string,
): VerifiedAgentProfileMedia {
  if (input.byteLength === 0) {
    throw new AgentProfileMediaValidationError('Profile image is empty.');
  }
  if (input.byteLength > MAX_AGENT_PROFILE_MEDIA_BYTES) {
    throw new AgentProfileMediaValidationError('Profile image exceeds the 5MB limit.', 413);
  }
  const declared = declaredContentType.trim().toLowerCase().split(';')[0] ?? '';
  if (!CONTENT_TYPES.has(declared as AgentProfileMediaType)) {
    throw new AgentProfileMediaValidationError('Only JPEG, PNG, and static WebP profile images are supported.');
  }
  const contentType = detectContentType(input);
  if (!contentType) {
    throw new AgentProfileMediaValidationError('Profile image bytes are not a valid supported raster image.');
  }
  if (contentType !== declared) {
    throw new AgentProfileMediaValidationError(`Profile image MIME mismatch: declared ${declared}, detected ${contentType}.`);
  }
  const bytes = Uint8Array.from(input);
  return {
    bytes,
    digest: createHash('sha256').update(bytes).digest('hex'),
    contentType,
    size: bytes.byteLength,
  };
}

type MediaRow = {
  digest: string;
  content_type: AgentProfileMediaType;
  size: number;
  created_at: string;
  bytes: Uint8Array;
};

export class AgentProfileMediaStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_profile_media (
        digest TEXT PRIMARY KEY,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        bytes BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_profile_media_owners (
        digest TEXT NOT NULL REFERENCES agent_profile_media(digest) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        bot_npub TEXT NOT NULL,
        manager_npub TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (digest, agent_id, bot_npub, manager_npub)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_profile_media_owner
        ON agent_profile_media_owners(agent_id, bot_npub, manager_npub);
    `);
  }

  put(verified: VerifiedAgentProfileMedia, owner: AgentProfileMediaOwner): AgentProfileMediaRecord {
    const createdAt = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      this.db.query(`
        INSERT OR IGNORE INTO agent_profile_media (digest, content_type, size, created_at, bytes)
        VALUES (?1, ?2, ?3, ?4, ?5)
      `).run(verified.digest, verified.contentType, verified.size, createdAt, verified.bytes);
      const existing = this.get(verified.digest);
      if (!existing || existing.contentType !== verified.contentType || existing.size !== verified.size) {
        throw new Error('Stored profile media metadata does not match its content digest.');
      }
      this.db.query(`
        INSERT OR IGNORE INTO agent_profile_media_owners
          (digest, agent_id, bot_npub, manager_npub, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
      `).run(verified.digest, owner.agentId, owner.botNpub, owner.managerNpub, createdAt);
      return existing;
    });
    return transaction.immediate();
  }

  get(digest: string): AgentProfileMediaRecord | null {
    if (!/^[0-9a-f]{64}$/.test(digest)) return null;
    const row = this.db.query(`
      SELECT digest, content_type, size, created_at, bytes
      FROM agent_profile_media WHERE digest = ?1
    `).get(digest) as MediaRow | null;
    if (!row) return null;
    return {
      digest: row.digest,
      contentType: row.content_type,
      size: Number(row.size),
      createdAt: row.created_at,
      bytes: Uint8Array.from(row.bytes),
    };
  }

  release(verified: Pick<VerifiedAgentProfileMedia, 'digest'>, owner: AgentProfileMediaOwner): void {
    const transaction = this.db.transaction(() => {
      this.db.query(`
        DELETE FROM agent_profile_media_owners
        WHERE digest = ?1 AND agent_id = ?2 AND bot_npub = ?3 AND manager_npub = ?4
      `).run(verified.digest, owner.agentId, owner.botNpub, owner.managerNpub);
      const remaining = this.db.query(`
        SELECT COUNT(*) AS count FROM agent_profile_media_owners WHERE digest = ?1
      `).get(verified.digest) as { count: number };
      if (Number(remaining.count) === 0) {
        this.db.query('DELETE FROM agent_profile_media WHERE digest = ?1').run(verified.digest);
      }
    });
    transaction.immediate();
  }

  listOwners(digest: string): AgentProfileMediaOwnerRecord[] {
    if (!/^[0-9a-f]{64}$/.test(digest)) return [];
    const rows = this.db.query(`
      SELECT agent_id, bot_npub, manager_npub, created_at
      FROM agent_profile_media_owners WHERE digest = ?1
      ORDER BY created_at, agent_id, bot_npub, manager_npub
    `).all(digest) as Array<{ agent_id: string; bot_npub: string; manager_npub: string; created_at: string }>;
    return rows.map((row) => ({
      agentId: row.agent_id,
      botNpub: row.bot_npub,
      managerNpub: row.manager_npub,
      createdAt: row.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}
