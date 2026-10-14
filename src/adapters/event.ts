import type { UsageEvent } from '../schema/usage-event.ts';
import { inferVendor } from './util.ts';

type Required = Pick<UsageEvent, 'dedupeKey' | 'source' | 'model' | 'ts' | 'sourceFile'>;

/** Build an event with zeroed counts and empty metadata, inferring vendor from the model. */
export function makeEvent(fields: Required & Partial<UsageEvent> & { providerId?: string | null }): UsageEvent {
  const { providerId, ...rest } = fields;
  // Windows tools disagree on drive-letter case (`s:\` vs `S:\`); fold it so projects group together
  if (rest.project) rest.project = rest.project.replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`);
  return {
    vendor: inferVendor(fields.model, providerId),
    sessionId: null,
    project: null,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    recordedCostUsd: null,
    granularity: 'request',
    meta: {},
    ...rest,
  };
}

export function hasUsage(e: UsageEvent): boolean {
  return e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens > 0;
}
