import { DatabaseSync } from "node:sqlite";

const connections = new Map<string, DatabaseSync>();

/** Single source of truth for the SQLite schema understood by this release. */
export const EXPECTED_SCHEMA_VERSION = 5;

export function getSharedConnection(dbPath: string): DatabaseSync {
  const existing = connections.get(dbPath);
  if (existing) return existing;
  const db = new DatabaseSync(dbPath);
  // WAL allows readers to continue while another connection writes. These
  // connection settings apply to every store sharing this connection.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);");
  runSchemaMigrations(db);
  connections.set(dbPath, db);
  return db;
}

export function getSchemaVersion(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (!row) return null;
  const parsed = parseInt(row.value, 10);
  return isNaN(parsed) ? null : parsed;
}

export function setSchemaVersion(db: DatabaseSync, version: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)",
  ).run(String(version));
}

/**
 * Version-gated migration entry point. Additive migrations belong in the
 * explicit switch below; until one exists, mismatched databases fail closed.
 */
export function runSchemaMigrations(db: DatabaseSync): void {
  const actual = getSchemaVersion(db);
  if (actual === null) {
    setSchemaVersion(db, EXPECTED_SCHEMA_VERSION);
    return;
  }
  if (actual !== EXPECTED_SCHEMA_VERSION) {
    throw new Error(
      `FATAL: unsupported database schema version: expected ${EXPECTED_SCHEMA_VERSION}, actual ${actual}`,
    );
  }
}

export function closeSharedConnection(dbPath: string): void {
  const db = connections.get(dbPath);
  if (db) {
    db.close();
    connections.delete(dbPath);
  }
}

export function closeAllSharedConnections(): void {
  for (const db of connections.values()) {
    db.close();
  }
  connections.clear();
}
