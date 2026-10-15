import type { UsageEvent } from '../schema/usage-event.ts';
import type { HttpOptions } from './http.ts';

export interface FetchRequest {
  /** Admin API key for the provider's organization. */
  key: string;
  /** Start of the first day to fetch (UTC midnight, inclusive). */
  since: Date;
  /** End of the range (UTC midnight, exclusive). */
  until: Date;
  http?: HttpOptions;
}

/**
 * Reads an organization's usage from a provider's usage API. Each event is one day's totals for
 * one combination of model, project and API key (`granularity: 'aggregate'`), not one request.
 */
export interface UsageConnector {
  id: string;
  displayName: string;
  /** Environment variable holding the admin key. */
  keyEnv: string;
  fetchUsage(req: FetchRequest): Promise<UsageEvent[]>;
}
