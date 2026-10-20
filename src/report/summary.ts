import { DISTINCT_CALLS, type UsageStore } from '../store/db.ts';

export const groupings = {
  source: 'source',
  model: 'model',
  vendor: 'vendor',
  project: "COALESCE(project, '(none)')",
  day: 'substr(ts, 1, 10)',
} as const;

export type Grouping = keyof typeof groupings;

export interface SummaryRow {
  key: string;
  events: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** Share of all input-side tokens served from cache. */
  cacheHitRate: number;
}

export function summarize(store: UsageStore, by: Grouping, filter: { since?: string; source?: string } = {}): SummaryRow[] {
  const where: string[] = filter.source ? [] : [DISTINCT_CALLS];
  const params: Record<string, string> = {};
  if (filter.since) {
    where.push('ts >= :since');
    params.since = filter.since;
  }
  if (filter.source) {
    where.push('source = :source');
    params.source = filter.source;
  }
  const rows = store.db
    .prepare(
      `SELECT ${groupings[by]} AS key, COUNT(*) AS events,
              SUM(input_tokens) AS input, SUM(output_tokens) AS output,
              SUM(cache_read_tokens) AS cacheRead, SUM(cache_write_tokens) AS cacheWrite
       FROM usage_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       GROUP BY key`,
    )
    .all(params) as Omit<SummaryRow, 'total' | 'cacheHitRate'>[];

  return rows
    .map((r) => {
      const inputSide = r.input + r.cacheRead + r.cacheWrite;
      return { ...r, total: inputSide + r.output, cacheHitRate: inputSide ? r.cacheRead / inputSide : 0 };
    })
    .sort((a, b) => (by === 'day' ? a.key.localeCompare(b.key) : b.total - a.total));
}
