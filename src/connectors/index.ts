import { totalTokens } from '../schema/usage-event.ts';
import type { UsageStore } from '../store/db.ts';
import { anthropicApi } from './anthropic.ts';
import type { HttpOptions } from './http.ts';
import { openaiApi } from './openai.ts';
import type { UsageConnector } from './types.ts';

export const connectors: readonly UsageConnector[] = [anthropicApi, openaiApi];

export function findConnector(id: string): UsageConnector | undefined {
  return connectors.find((c) => c.id === id);
}

export interface FetchOptions {
  connectors?: readonly UsageConnector[];
  since: Date;
  until: Date;
  http?: HttpOptions;
}

export interface FetchResult {
  source: string;
  status: 'ok' | 'skipped' | 'failed';
  /** Why the connector was skipped or failed. */
  detail?: string;
  events: number;
  tokens: number;
}

/**
 * Fetch each connector whose key is set and replace its stored usage for the range, so a day
 * fetched again (late-arriving usage, a partial day) overwrites the earlier totals. One
 * connector failing does not stop the others.
 */
export async function fetchAll(store: UsageStore, env: Record<string, string | undefined>, opts: FetchOptions): Promise<FetchResult[]> {
  const results: FetchResult[] = [];
  for (const connector of opts.connectors ?? connectors) {
    const key = env[connector.keyEnv];
    if (!key) {
      results.push({ source: connector.id, status: 'skipped', detail: `${connector.keyEnv} is not set`, events: 0, tokens: 0 });
      continue;
    }
    try {
      const events = await connector.fetchUsage({ key, since: opts.since, until: opts.until, http: opts.http });
      store.replaceRange(connector.id, opts.since.toISOString(), opts.until.toISOString(), events);
      results.push({ source: connector.id, status: 'ok', events: events.length, tokens: events.reduce((n, e) => n + totalTokens(e), 0) });
    } catch (err) {
      results.push({ source: connector.id, status: 'failed', detail: err instanceof Error ? err.message : String(err), events: 0, tokens: 0 });
    }
  }
  return results;
}

export type { UsageConnector } from './types.ts';
