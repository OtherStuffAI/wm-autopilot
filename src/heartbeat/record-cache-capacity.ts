import type { Database } from "bun:sqlite";

// Retain downloaded generations and rollback evidence; capacity is not an eviction policy.
export const DEFAULT_RECORD_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_RECORD_CACHE_BYTES = 16 * 1024 * 1024 * 1024;
const CONFIG = "WINGMAN_HEARTBEAT_CACHE_MAX_BYTES";

export function recordCacheMaxBytes(value = process.env[CONFIG]): number {
  const bytes = value === undefined ? DEFAULT_RECORD_CACHE_BYTES : Number(value);
  if ((value !== undefined && !/^[1-9]\d*$/.test(value)) ||
    !Number.isSafeInteger(bytes) || bytes < 1024 * 1024 || bytes > MAX_RECORD_CACHE_BYTES)
    throw new Error(`${CONFIG} must be an integer byte count between 1048576 and ${MAX_RECORD_CACHE_BYTES}`);
  return bytes;
}

function pragma(db: Database, name: string): number {
  return Number(Object.values(db.query(`PRAGMA ${name}`).get() as Record<string, number>)[0]);
}

export function recordCacheStorage(db: Database) {
  const pageBytes = pragma(db, "page_size");
  return {
    allocatedBytes: pragma(db, "page_count") * pageBytes,
    freeBytes: pragma(db, "freelist_count") * pageBytes,
    limitBytes: pragma(db, "max_page_count") * pageBytes,
  };
}

/** SQLite silently raises a requested limit below the existing file size. Reject
 * that configuration explicitly instead of pretending its bound was enforced.
 */
export function configureRecordCacheCapacity(db: Database, bytes = recordCacheMaxBytes()): void {
  recordCacheMaxBytes(String(bytes));
  const pageBytes = pragma(db, "page_size");
  const pages = Math.floor(bytes / pageBytes);
  const allocated = pragma(db, "page_count");
  if (allocated > pages)
    throw new Error(`Heartbeat cache already allocates ${allocated * pageBytes} bytes, exceeding ${CONFIG}=${bytes}; increase the configured bound without deleting saved progress`);
  const applied = pragma(db, `max_page_count=${pages}`);
  if (applied !== pages) throw new Error("SQLite did not apply the heartbeat cache capacity bound");
}

export function recordCacheError(db: Database, error: unknown): unknown {
  if (!(error instanceof Error) ||
    ((error as Error & { code?: string }).code !== "SQLITE_FULL" && error.message !== "database or disk is full"))
    return error;
  const storage = recordCacheStorage(db);
  return new Error(`Heartbeat cache write failed: database or disk is full (allocated ${storage.allocatedBytes} bytes, reusable ${storage.freeBytes} bytes, configured ceiling ${storage.limitBytes} bytes). Saved sync progress is retained; check disk space and ${CONFIG} before retrying. No cache eviction was performed.`, { cause: error });
}
