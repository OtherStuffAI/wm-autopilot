import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { getConfiguredAdminNpubs, normaliseNpub } from "../identity/npub-utils";

const PORT_START = 41000;
const PORTS_PER_USER = 1000;
const MAX_INT32 = 2_147_483_647;

export class InsufficientBalanceError extends Error {
  readonly balance: number;
  readonly required: number;

  constructor(balance: number, required: number) {
    super(`Insufficient balance: requires ${required} sats, available ${balance} sats.`);
    this.name = "InsufficientBalanceError";
    this.balance = balance;
    this.required = required;
  }
}

export interface IdentityUserRecord {
  npub: string;
  normalizedNpub: string;
  alias: string;
  nickname: string | null;
  profileName: string | null;
  pictureUrl: string | null;
  roles: string[];
  onboardedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  ports: number[];
  balance: number;
}

type IdentityUserRow = {
  normalizedNpub: string;
  npub: string;
  alias: string;
  nickname: string | null;
  profileName: string | null;
  pictureUrl: string | null;
  roles: string;
  onboardedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  ports: string | null;
  balance: number | null;
};

type TouchOptions = {
  alias?: string | null;
  lastSeenAt?: string | Date | null;
};

const DEFAULT_DB_PATH = new URL("../../data/identity-users.db", import.meta.url).pathname;

const parseRoles = (input: string | null | undefined): string[] => {
  if (!input || input.trim().length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(input);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
};

const toIsoString = (value: string | Date | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return value.toISOString();
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return trimmed;
  }
  return date.toISOString();
};

export class IdentityUserStore {
  private readonly db: Database;
  private nextPort: number = PORT_START;

  constructor(filePath: string = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
    this.ensurePortsColumn();
    this.ensureBalanceColumn();
    this.ensureNicknameColumn();
    this.ensureProfileNameColumn();
    this.ensurePictureColumn();
    this.synchronisePortAssignments();
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identity_users (
        normalized_npub TEXT PRIMARY KEY,
        npub TEXT NOT NULL,
        alias TEXT NOT NULL,
        nickname TEXT,
        profile_name TEXT,
        picture_url TEXT,
        roles TEXT NOT NULL DEFAULT '[]',
        onboarded_at TEXT,
        last_seen_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ports TEXT,
        balance INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  private ensurePortsColumn() {
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(identity_users)").all();
    const hasPortsColumn = columns.some((column) => column?.name === "ports");
    if (!hasPortsColumn) {
      this.db.exec(`ALTER TABLE identity_users ADD COLUMN ports TEXT`);
    }
  }

  private ensureBalanceColumn() {
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(identity_users)").all();
    const hasBalanceColumn = columns.some((column) => column?.name === "balance");
    if (!hasBalanceColumn) {
      this.db.exec(`ALTER TABLE identity_users ADD COLUMN balance INTEGER NOT NULL DEFAULT 0`);
    } else {
      this.db.exec(`UPDATE identity_users SET balance = 0 WHERE balance IS NULL`);
    }
  }

  private ensureNicknameColumn() {
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(identity_users)").all();
    const hasNicknameColumn = columns.some((column) => column?.name === "nickname");
    if (!hasNicknameColumn) {
      this.db.exec(`ALTER TABLE identity_users ADD COLUMN nickname TEXT`);
    }
  }

  private ensurePictureColumn() {
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(identity_users)").all();
    const hasPictureColumn = columns.some((column) => column?.name === "picture_url");
    if (!hasPictureColumn) {
      this.db.exec(`ALTER TABLE identity_users ADD COLUMN picture_url TEXT`);
    }
  }

  private ensureProfileNameColumn() {
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(identity_users)").all();
    const hasProfileNameColumn = columns.some((column) => column?.name === "profile_name");
    if (!hasProfileNameColumn) {
      this.db.exec(`ALTER TABLE identity_users ADD COLUMN profile_name TEXT`);
    }
  }

  ensureAdminBalance() {
    const adminNpubs = getConfiguredAdminNpubs();
    if (adminNpubs.length === 0) {
      return;
    }
    for (const adminNpub of adminNpubs) {
      const normalized = normaliseNpub(adminNpub);
      if (!normalized) {
        continue;
      }
      const ADMIN_MIN_BALANCE = 10_000;
      const ADMIN_TARGET_BALANCE = 1_000_000;
      const existing = this.get(normalized);
      const currentBalance = existing?.balance ?? 0;
      if (currentBalance >= ADMIN_MIN_BALANCE) {
        continue;
      }
      if (!existing) {
        this.touch(adminNpub);
      }
      this.setBalance(normalized, ADMIN_TARGET_BALANCE);
      console.log(`[identity] Topped up admin ${adminNpub.slice(0, 12)}... to ${ADMIN_TARGET_BALANCE.toLocaleString()} sats`);
    }
  }

  private parsePorts(value: string | null | undefined): number[] {
    if (!value || value.trim().length === 0) {
      return [];
    }
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) {
        return [];
      }
      const unique = new Set<number>();
      for (const entry of parsed) {
        const parsedValue =
          typeof entry === "number" ? entry : Number.parseInt(String(entry), 10);
        if (Number.isInteger(parsedValue) && parsedValue >= 0) {
          unique.add(parsedValue);
        }
      }
      return Array.from(unique).sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  private portsEqual(left: number[], right: number[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }

  private collectAssignedPorts(): Set<number> {
    const rows = this.db.query<{ ports: string | null }, []>("SELECT ports FROM identity_users").all();
    const assigned = new Set<number>();
    for (const row of rows) {
      for (const port of this.parsePorts(row.ports)) {
        assigned.add(port);
      }
    }
    return assigned;
  }

  private calculateNextPort(): number {
    const assigned = this.collectAssignedPorts();
    let maxAssignedPort = PORT_START - 1;
    for (const port of assigned) {
      if (port > maxAssignedPort) {
        maxAssignedPort = port;
      }
    }
    return maxAssignedPort >= PORT_START ? maxAssignedPort + 1 : PORT_START;
  }

  private allocateAvailablePorts(count: number, assigned: Set<number> = this.collectAssignedPorts()): number[] {
    const safeCount = Math.max(0, Math.trunc(Number.isFinite(count) ? count : 0));
    const ports: number[] = [];
    let candidate = Number.isInteger(this.nextPort) && this.nextPort >= PORT_START
      ? this.nextPort
      : this.calculateNextPort();

    while (ports.length < safeCount) {
      if (!assigned.has(candidate)) {
        assigned.add(candidate);
        ports.push(candidate);
      }
      candidate += 1;
    }

    this.nextPort = candidate;
    return ports;
  }

  private synchronisePortAssignments() {
    const rows = this.db
      .query<{ normalizedNpub: string; ports: string | null; createdAt: string }, []>(
        `SELECT
           normalized_npub as normalizedNpub,
           ports,
           created_at as createdAt
         FROM identity_users
         ORDER BY created_at ASC, normalized_npub ASC`,
      )
      .all();

    if (rows.length === 0) {
      this.nextPort = PORT_START;
      return;
    }

    const update = this.db.prepare(
      `UPDATE identity_users
         SET ports = ?2,
             updated_at = ?3
       WHERE normalized_npub = ?1`,
    );
    const now = new Date().toISOString();

    let next = this.calculateNextPort();
    const assigned = this.collectAssignedPorts();
    for (const row of rows) {
      const currentPorts = this.parsePorts(row.ports);
      if (currentPorts.length >= PORTS_PER_USER) {
        continue;
      }
      this.nextPort = next;
      const extraPorts = this.allocateAvailablePorts(PORTS_PER_USER - currentPorts.length, assigned);
      next = this.nextPort;
      const expected = [...currentPorts, ...extraPorts].sort((a, b) => a - b);
      if (!this.portsEqual(currentPorts, expected)) {
        update.run(row.normalizedNpub, JSON.stringify(expected), now);
      }
    }

    this.nextPort = next;
  }

  private allocatePorts(): number[] {
    if (!Number.isInteger(this.nextPort) || this.nextPort < PORT_START) {
      this.nextPort = this.calculateNextPort();
    }
    return this.allocateAvailablePorts(PORTS_PER_USER);
  }

  private allocateExtraPorts(count: number): number[] {
    if (!Number.isInteger(this.nextPort) || this.nextPort < PORT_START) {
      this.nextPort = this.calculateNextPort();
    }
    return this.allocateAvailablePorts(count);
  }

  addPortsToUser(npub: string, count: number = PORTS_PER_USER): IdentityUserRecord {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      throw new Error("A valid npub is required");
    }
    const record = this.touch(npub);
    const portCount = Math.max(1, Math.min(PORTS_PER_USER, Math.trunc(Number.isFinite(count) ? count : PORTS_PER_USER)));

    const currentPorts = record.ports;
    const newPorts = this.allocateExtraPorts(portCount);
    const allPorts = [...currentPorts, ...newPorts].sort((a, b) => a - b);

    const now = new Date().toISOString();
    const update = this.db.prepare(
      `UPDATE identity_users
         SET ports = ?2,
             updated_at = ?3
       WHERE normalized_npub = ?1`,
    );
    update.run(normalized, JSON.stringify(allPorts), now);
    return this.getOrThrow(normalized);
  }

  listUsers(): IdentityUserRecord[] {
    const statement = this.db.prepare<IdentityUserRow, []>(
      `SELECT
         normalized_npub as normalizedNpub,
         npub,
         alias,
         nickname,
         profile_name as profileName,
         picture_url as pictureUrl,
         roles,
         onboarded_at as onboardedAt,
         last_seen_at as lastSeenAt,
         created_at as createdAt,
         updated_at as updatedAt,
         ports,
         balance
       FROM identity_users
       ORDER BY alias`,
    );
    const rows = statement.all();
    return rows.map((row) => this.hydrate(row));
  }

  ensurePortAssignments(): IdentityUserRecord[] {
    this.synchronisePortAssignments();
    return this.listUsers();
  }

  getByNormalized(normalizedNpub: string): IdentityUserRecord | null {
    if (!normalizedNpub) {
      return null;
    }
    return this.get(normalizedNpub);
  }

  ensurePortsFor(npub: string | null | undefined): number[] {
    const normalized = normaliseNpub(npub ?? null);
    if (!normalized) {
      return [];
    }
    const existing = this.get(normalized);
    if (existing) {
      return existing.ports;
    }
    const created = this.touch(normalized);
    return created.ports;
  }

  touch(npub: string, options: TouchOptions = {}): IdentityUserRecord {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      throw new Error("A valid npub is required");
    }
    const aliasInput = typeof options.alias === "string" ? options.alias.trim() : null;
    const lastSeenIso = toIsoString(options.lastSeenAt);
    const existing = this.get(normalized);
    const now = new Date().toISOString();

    if (existing) {
      this.updateRecord(normalized, npub, aliasInput, lastSeenIso, now);
      return this.getOrThrow(normalized);
    }

    const alias = aliasInput && aliasInput.length > 0 ? aliasInput : npub;
    const ports = this.allocatePorts();

    const insert = this.db.prepare(
      `INSERT INTO identity_users (
         normalized_npub,
         npub,
         alias,
         nickname,
         profile_name,
         picture_url,
         roles,
         onboarded_at,
         last_seen_at,
         created_at,
         updated_at,
         ports,
         balance
       ) VALUES (?1, ?2, ?3, NULL, NULL, NULL, '[]', NULL, ?4, ?5, ?5, ?6, ?7)`,
    );
    insert.run(normalized, npub, alias, lastSeenIso, now, JSON.stringify(ports), 0);

    return this.getOrThrow(normalized);
  }

  touchExisting(npub: string, options: TouchOptions = {}): IdentityUserRecord | null {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      throw new Error("A valid npub is required");
    }
    const existing = this.get(normalized);
    if (!existing) {
      return null;
    }
    const aliasInput = typeof options.alias === "string" ? options.alias.trim() : null;
    const lastSeenIso = toIsoString(options.lastSeenAt);
    const now = new Date().toISOString();
    this.updateRecord(normalized, npub, aliasInput, lastSeenIso, now);
    return this.getOrThrow(normalized);
  }

  private updateRecord(
    normalized: string,
    npub: string,
    aliasInput: string | null,
    lastSeenIso: string | null,
    updatedIso: string,
  ) {
    const update = this.db.prepare(
      `UPDATE identity_users
         SET npub = ?2,
             alias = CASE WHEN ?3 IS NOT NULL AND length(?3) > 0 THEN ?3 ELSE alias END,
             last_seen_at = CASE WHEN ?4 IS NOT NULL THEN ?4 ELSE last_seen_at END,
             updated_at = ?5
       WHERE normalized_npub = ?1`,
    );
    update.run(normalized, npub, aliasInput, lastSeenIso, updatedIso);
  }

  setRole(npub: string, role: string, enabled: boolean): IdentityUserRecord {
    const record = this.touch(npub);
    const normalized = record.normalizedNpub;
    const roles = new Set(record.roles);
    if (enabled) {
      roles.add(role);
    } else {
      roles.delete(role);
    }
    const updatedRoles = JSON.stringify(Array.from(roles).sort());
    const now = new Date().toISOString();
    const onboardedAt =
      role === "onboard" ? (enabled ? now : null) : record.onboardedAt;

    const update = this.db.prepare(
      `UPDATE identity_users
         SET roles = ?2,
             onboarded_at = ?3,
             updated_at = ?4
       WHERE normalized_npub = ?1`,
    );
    update.run(normalized, updatedRoles, onboardedAt, now);

    return this.getOrThrow(normalized);
  }

  setBalance(npub: string, satoshis: number): IdentityUserRecord {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      throw new Error("A valid npub is required");
    }
    const record = this.touch(npub);
    const desired = Math.max(0, Math.trunc(Number.isFinite(satoshis) ? satoshis : 0));
    if (record.balance === desired) {
      return record;
    }
    const update = this.db.prepare(
      `UPDATE identity_users
         SET balance = ?2,
             updated_at = ?3
       WHERE normalized_npub = ?1`,
    );
    const now = new Date().toISOString();
    update.run(normalized, desired, now);
    return this.getOrThrow(normalized);
  }

  setNickname(npub: string, nickname: string | null | undefined): IdentityUserRecord {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      throw new Error("A valid npub is required");
    }
    const record = this.touch(npub);
    const sanitized = typeof nickname === "string" ? nickname.trim() : "";
    const nextNickname = sanitized.length > 0 ? sanitized.slice(0, 160) : null;
    if (record.nickname === nextNickname) {
      return record;
    }

    const update = this.db.prepare(
      `UPDATE identity_users
         SET nickname = ?2,
             updated_at = ?3
       WHERE normalized_npub = ?1`,
    );
    const now = new Date().toISOString();
    update.run(normalized, nextNickname, now);
    return this.getOrThrow(normalized);
  }

  setPictureUrl(npub: string, pictureUrl: string | null | undefined): IdentityUserRecord {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      throw new Error("A valid npub is required");
    }
    const record = this.touch(npub);
    const sanitized = typeof pictureUrl === "string" ? pictureUrl.trim() : "";
    let nextUrl: string | null = null;
    if (sanitized.length > 0) {
      try {
        const parsed = new URL(sanitized);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          nextUrl = parsed.toString();
        }
      } catch {
        nextUrl = null;
      }
    }
    if (record.pictureUrl === nextUrl) {
      return record;
    }

    const update = this.db.prepare(
      `UPDATE identity_users
         SET picture_url = ?2,
             updated_at = ?3
       WHERE normalized_npub = ?1`,
    );
    const now = new Date().toISOString();
    update.run(normalized, nextUrl, now);
    return this.getOrThrow(normalized);
  }

  setProfileName(npub: string, profileName: string | null | undefined): IdentityUserRecord {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      throw new Error("A valid npub is required");
    }
    const record = this.touch(npub);
    const sanitized = typeof profileName === "string" ? profileName.trim().slice(0, 160) : "";
    const nextName = sanitized.length > 0 ? sanitized : null;
    if (record.profileName === nextName) {
      return record;
    }
    this.db.prepare(
      `UPDATE identity_users
         SET profile_name = ?2,
             updated_at = ?3
       WHERE normalized_npub = ?1`,
    ).run(normalized, nextName, new Date().toISOString());
    return this.getOrThrow(normalized);
  }

  credit(npub: string, satoshis: number): number {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      throw new Error("A valid npub is required");
    }
    const amount = this.sanitiseAmount(satoshis);
    if (amount <= 0) {
      return this.getOrThrow(normalized).balance;
    }

    this.touch(npub);
    const now = new Date().toISOString();
    const update = this.db.prepare(
      `UPDATE identity_users
         SET balance = MIN(balance + ?2, ?4),
             updated_at = ?3
       WHERE normalized_npub = ?1`,
    );
    update.run(normalized, amount, now, MAX_INT32);
    return this.getOrThrow(normalized).balance;
  }

  debit(npub: string, satoshis: number): number {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      throw new Error("A valid npub is required");
    }
    const amount = this.sanitiseAmount(satoshis);
    if (amount <= 0) {
      return this.getOrThrow(normalized).balance;
    }

    this.touch(npub);
    const now = new Date().toISOString();
    const update = this.db.prepare(
      `UPDATE identity_users
         SET balance = balance - ?2,
             updated_at = ?3
       WHERE normalized_npub = ?1
         AND balance >= ?2`,
    );
    const result = update.run(normalized, amount, now);
    if (!result || result.changes !== 1) {
      const current = this.get(normalized);
      const available = current?.balance ?? 0;
      throw new InsufficientBalanceError(available, amount);
    }
    return this.getOrThrow(normalized).balance;
  }

  deleteUser(npub: string): boolean {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      throw new Error("A valid npub is required");
    }

    const deleteStmt = this.db.prepare(
      `DELETE FROM identity_users WHERE normalized_npub = ?1`,
    );
    const result = deleteStmt.run(normalized);

    if (result && result.changes > 0) {
      this.synchronisePortAssignments();
      return true;
    }
    return false;
  }

  private get(normalizedNpub: string): IdentityUserRecord | null {
    const statement = this.db.prepare<IdentityUserRow, [string]>(
      `SELECT
         normalized_npub as normalizedNpub,
         npub,
         alias,
         nickname,
         profile_name as profileName,
         picture_url as pictureUrl,
         roles,
         onboarded_at as onboardedAt,
         last_seen_at as lastSeenAt,
         created_at as createdAt,
         updated_at as updatedAt,
         ports,
         balance
       FROM identity_users
       WHERE normalized_npub = ?1`,
    );
    const row = statement.get(normalizedNpub);
    if (!row) return null;
    return this.hydrate(row);
  }

  private getOrThrow(normalizedNpub: string): IdentityUserRecord {
    const record = this.get(normalizedNpub);
    if (!record) {
      throw new Error(`Failed to load identity user ${normalizedNpub}`);
    }
    return record;
  }

  private hydrate(row: IdentityUserRow): IdentityUserRecord {
    return {
      npub: row.npub,
      normalizedNpub: row.normalizedNpub,
      alias: row.alias,
      nickname: row.nickname && row.nickname.trim().length > 0 ? row.nickname.trim() : null,
      profileName: row.profileName && row.profileName.trim().length > 0 ? row.profileName.trim() : null,
      pictureUrl: row.pictureUrl && row.pictureUrl.trim().length > 0 ? row.pictureUrl.trim() : null,
      roles: Array.from(new Set(parseRoles(row.roles))).sort(),
      onboardedAt: row.onboardedAt ?? null,
      lastSeenAt: row.lastSeenAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ports: this.parsePorts(row.ports),
      balance: this.normaliseBalance(row.balance),
    };
  }

  private normaliseBalance(value: number | null | undefined): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.trunc(value));
    }
    if (value === null || value === undefined) {
      return 0;
    }
    const parsed = Number.parseInt(String(value), 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.trunc(parsed));
    }
    return 0;
  }

  private sanitiseAmount(value: number, options?: { allowZero?: boolean }): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    const normalized = Math.trunc(value);
    if (normalized <= 0) {
      return options?.allowZero ? 0 : 0;
    }
    return Math.min(normalized, MAX_INT32);
  }
}

export const identityUserStore = new IdentityUserStore();
