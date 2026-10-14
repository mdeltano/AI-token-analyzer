import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { UsageEvent } from '../schema/usage-event.ts';
import { hasUsage, makeEvent } from './event.ts';
import type { SourceAdapter } from './types.ts';
import { isObject, isoTime, readJson, str, tokens, walkFiles } from './util.ts';

/** OpenCode message payload, shared by the legacy JSON files and both SQLite generations. */
function toEvent(data: Record<string, any>, ids: { sessionId: string; messageId: string; createdMs: unknown }, file: string): UsageEvent | null {
  const role = data.role ?? data.type;
  if (role !== 'assistant' && role !== 'model') return null;
  const model = str(data.modelID) ?? str(data.model?.id) ?? str(data.model);
  const providerId = str(data.providerID) ?? str(data.model?.providerID);
  const ts = isoTime(data.time?.created) ?? isoTime(ids.createdMs);
  if (!model || !ts) return null;

  const t = isObject(data.tokens) ? data.tokens : {};
  const u = isObject(data.usage) ? data.usage : {};
  const output = tokens(t.output ?? u.output_tokens);
  // OpenCode reports reasoning separately from output, so it is added back as billable output
  const reasoning = tokens(t.reasoning);
  const event = makeEvent({
    dedupeKey: `opencode:${ids.sessionId}:${ids.messageId}`,
    source: 'opencode',
    providerId,
    model,
    ts,
    sessionId: ids.sessionId,
    project: str(data.path?.cwd) ?? str(data.path?.root),
    inputTokens: tokens(t.input ?? u.input_tokens),
    outputTokens: output + reasoning,
    reasoningTokens: reasoning,
    cacheReadTokens: tokens(t.cache?.read ?? u.cache_read_input_tokens),
    cacheWriteTokens: tokens(t.cache?.write ?? u.cache_creation_input_tokens),
    recordedCostUsd: typeof data.cost === 'number' && data.cost > 0 ? data.cost : null,
    sourceFile: file,
    meta: { providerId },
  });
  return hasUsage(event) ? event : null;
}

function parseJsonMessage(file: string): UsageEvent[] {
  const data = readJson(file);
  if (!isObject(data)) return [];
  const sessionId = str(data.sessionID) ?? basename(dirname(file));
  const messageId = str(data.id) ?? basename(file, '.json');
  const e = toEvent(data, { sessionId, messageId, createdMs: null }, file);
  return e ? [e] : [];
}

function parseDatabase(file: string): UsageEvent[] {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const tables = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name),
    );
    const queries: string[] = [];
    if (tables.has('message')) {
      queries.push(`SELECT session_id, id, time_created, CAST(data AS TEXT) AS data, NULL AS type FROM message`);
    }
    if (tables.has('session_message')) {
      queries.push(`SELECT session_id, id, time_created, CAST(data AS TEXT) AS data, type FROM session_message`);
    }
    const out: UsageEvent[] = [];
    const seen = new Set<string>();
    for (const sql of queries) {
      for (const row of db.prepare(sql).all() as Record<string, any>[]) {
        let data: unknown;
        try {
          data = JSON.parse(String(row.data));
        } catch {
          continue;
        }
        if (!isObject(data)) continue;
        if (row.type && !data.role) data.role = row.type;
        const e = toEvent(data, { sessionId: String(row.session_id), messageId: String(row.id), createdMs: row.time_created }, file);
        // migrated v2 rows keep their legacy ids, so the key collapses the duplicate
        if (e && !seen.has(e.dedupeKey)) {
          seen.add(e.dedupeKey);
          out.push(e);
        }
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * OpenCode: `$OPENCODE_DATA_DIR` or `$XDG_DATA_HOME/opencode` (default `~/.local/share/opencode`).
 * Current versions store messages in `opencode*.db`; older ones wrote
 * `storage/message/<sessionID>/<messageID>.json`. Both are read; keys dedupe migrated rows.
 */
export const opencode: SourceAdapter = {
  id: 'opencode',
  displayName: 'OpenCode',

  defaultRoots({ home, env }) {
    if (env.OPENCODE_DATA_DIR) return [env.OPENCODE_DATA_DIR];
    return [join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode')];
  },

  discover(root) {
    const dbs = walkFiles(root, (p) => dirname(p) === root && /^opencode[^\\/]*\.db$/.test(basename(p)));
    const messages = walkFiles(join(root, 'storage', 'message'), (p) => p.endsWith('.json'));
    return [...dbs, ...messages];
  },

  parse(file) {
    return file.endsWith('.db') ? parseDatabase(file) : parseJsonMessage(file);
  },
};
