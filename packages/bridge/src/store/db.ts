/**
 * SQLite open factory + migrations — plan §7.2.
 *
 * - journal_mode=WAL, synchronous=FULL, foreign_keys=ON, busy_timeout=5000
 *   on EVERY connection (per-connection pragmas, not per-table).
 * - schema_migrations table; SCHEMA_VERSION independent of doc version.
 * - Corrupt DB → renamed to <file>.corrupt-<ts> + typed CorruptDatabaseError
 *   (caller decides whether to recreate fresh — never silent).
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";

import { SCHEMA_SQL, SCHEMA_VERSION, SEED_SQL } from "./schema.js";

export class CorruptDatabaseError extends Error {
  readonly backupPath: string;
  constructor(dbPath: string, backupPath: string, cause: unknown) {
    super(`SQLite database at ${dbPath} is corrupt; backed up to ${backupPath}`);
    this.name = "CorruptDatabaseError";
    this.backupPath = backupPath;
    this.cause = cause;
  }
}

export type GatewayDb = DatabaseSync;

export function openDb(dbPath: string): GatewayDb {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function isCorruptionError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /malformed|corrupt|not a database|database disk image/i.test(msg);
}

function currentSchemaVersion(db: GatewayDb): number {
  try {
    const row = db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations")
      .get() as { v: number };
    return row.v;
  } catch {
    return 0;
  }
}

/**
 * Open (creating if needed) + migrate to SCHEMA_VERSION.
 * Throws CorruptDatabaseError after backing up an unreadable DB.
 */
export async function openGatewayDb(dataDir: string): Promise<GatewayDb> {
  await fs.mkdir(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "gateway.db");

  // Probe readability first so corruption is detected before pragmas
  try {
    const probe = openDb(dbPath);
    probe.exec("SELECT 1");
    probe.close();
  } catch (err) {
    if (!isCorruptionError(err)) throw err;
    const backupPath = `${dbPath}.corrupt-${Date.now()}`;
    await fs.rename(dbPath, backupPath).catch(async () => {
      await fs.copyFile(dbPath, backupPath);
    });
    throw new CorruptDatabaseError(dbPath, backupPath, err);
  }

  const db = openDb(dbPath);
  try {
    migrate(db);
  } catch (err) {
    db.close();
    if (isCorruptionError(err)) {
      const backupPath = `${dbPath}.corrupt-${Date.now()}`;
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        /* ignore */
      }
      await fs.rename(dbPath, backupPath).catch(async () => {
        await fs.copyFile(dbPath, backupPath);
      });
      throw new CorruptDatabaseError(dbPath, backupPath, err);
    }
    throw err;
  }
  return db;
}

/** Idempotent — safe to run on every open. */
export function migrate(db: GatewayDb): void {
  const version = currentSchemaVersion(db);
  if (version >= SCHEMA_VERSION) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    // v1: full §7.2 DDL (all CREATE ... IF NOT EXISTS → idempotent)
    db.exec(SCHEMA_SQL);
    db.exec(SEED_SQL);
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?) ON CONFLICT(version) DO NOTHING",
    ).run(SCHEMA_VERSION, Date.now());
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** §7.2 startup integrity checks — must all return 0 rows. */
export function runIntegrityChecks(db: GatewayDb): string[] {
  const violations: string[] = [];

  // conversation_key ↔ conversations 1—1 current
  const orphanConversations = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks t
       LEFT JOIN conversations c
         ON c.conversation_key = t.conversation_key
        AND c.task_id = t.task_id
        AND c.is_current = 1
       WHERE c.conversation_key IS NULL`,
    )
    .get() as { n: number };
  if (orphanConversations.n !== 0) {
    violations.push(`tasks without current conversation: ${orphanConversations.n}`);
  }

  const multiCurrent = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks t
       WHERE (SELECT COUNT(*) FROM conversations c2
              WHERE c2.task_id = t.task_id AND c2.is_current = 1) <> 1`,
    )
    .get() as { n: number };
  if (multiCurrent.n !== 0) {
    violations.push(`tasks without exactly one current conversation: ${multiCurrent.n}`);
  }

  // task events must reference existing tasks (no FK by design)
  const orphanEvents = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events e
       LEFT JOIN tasks t ON t.task_id = e.task_id
       WHERE e.stream = 'task' AND t.task_id IS NULL`,
    )
    .get() as { n: number };
  if (orphanEvents.n !== 0) {
    violations.push(`orphan task events: ${orphanEvents.n}`);
  }

  // seq audit: MAX(seq) <= tasks.last_seq must hold (never >)
  const seqViolations = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks t
       WHERE (SELECT COALESCE(MAX(seq),0) FROM events e
              WHERE e.stream='task' AND e.task_id=t.task_id) > t.last_seq`,
    )
    .get() as { n: number };
  if (seqViolations.n !== 0) {
    violations.push(`seq audit violations (MAX(seq) > last_seq): ${seqViolations.n}`);
  }

  return violations;
}
