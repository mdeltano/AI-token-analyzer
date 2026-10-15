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

  /** Read stored events back, oldest first. */
  events(filter: { since?: string; source?: string } = {}): UsageEvent[] {
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (filter.since) {
      where.push('ts >= :since');
      params.since = filter.since;
    }
    if (filter.source) {
      where.push('source = :source');
      params.source = filter.source;
    }
    const rows = this.db
      .prepare(`SELECT * FROM usage_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ts, dedupe_key`)
      .all(params) as Record<string, string | number | null>[];
    return rows.map((r) => ({
      dedupeKey: r.dedupe_key as string,
      source: r.source as string,
      vendor: r.vendor as string,
      model: r.model as string,
      ts: r.ts as string,
      sessionId: r.session_id as string | null,
      project: r.project as string | null,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      reasoningTokens: r.reasoning_tokens as number,
      cacheReadTokens: r.cache_read_tokens as number,
      cacheWriteTokens: r.cache_write_tokens as number,
      recordedCostUsd: r.recorded_cost_usd as number | null,
      granularity: r.granularity as UsageEvent['granularity'],
      sourceFile: r.source_file as string,
      meta: JSON.parse(r.meta as string) as UsageEvent['meta'],
    }));
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
