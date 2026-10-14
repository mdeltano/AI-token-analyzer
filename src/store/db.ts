import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { usageEventSchema, type UsageEvent } from '../schema/usage-event.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_events (
  dedupe_key         TEXT PRIMARY KEY,
  source             TEXT NOT NULL,
  vendor             TEXT NOT NULL,
  model              TEXT NOT NULL,
  ts                 TEXT NOT NULL,
  session_id         TEXT,
  project            TEXT,
  input_tokens       INTEGER NOT NULL,
  output_tokens      INTEGER NOT NULL,
  reasoning_tokens   INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  recorded_cost_usd  REAL,
  granularity        TEXT NOT NULL,
  source_file        TEXT NOT NULL,
  meta               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_events_ts ON usage_events (ts);
CREATE INDEX IF NOT EXISTS usage_events_source_model ON usage_events (source, model);

-- size+mtime of each imported file, so unchanged files are skipped on the next import
CREATE TABLE IF NOT EXISTS imported_files (
  path        TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  imported_at TEXT NOT NULL
);
`;

export interface FileStamp {
  size: number;
  mtimeMs: number;
}

export class UsageStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  /** Insert events, ignoring ones already stored. Returns how many were new. */
  insert(events: UsageEvent[]): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO usage_events VALUES (
        :dedupeKey, :source, :vendor, :model, :ts, :sessionId, :project, :inputTokens, :outputTokens,
        :reasoningTokens, :cacheReadTokens, :cacheWriteTokens, :recordedCostUsd, :granularity, :sourceFile, :meta)`);
    let added = 0;
    this.transaction(() => {
      for (const raw of events) {
        const e = usageEventSchema.parse(raw);
        const r = stmt.run({ ...e, meta: JSON.stringify(e.meta) });
        added += Number(r.changes);
      }
    });
    return added;
  }

  fileStamp(path: string): FileStamp | undefined {
    const row = this.db.prepare('SELECT size, mtime_ms FROM imported_files WHERE path = ?').get(path) as
      | { size: number; mtime_ms: number }
      | undefined;
    return row && { size: row.size, mtimeMs: row.mtime_ms };
  }

  recordFile(path: string, source: string, stamp: FileStamp): void {
    this.db
      .prepare(
        `INSERT INTO imported_files VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, imported_at = excluded.imported_at`,
      )
      .run(path, source, stamp.size, Math.trunc(stamp.mtimeMs), new Date().toISOString());
  }

  transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
