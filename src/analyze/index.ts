import { eventCost } from '../pricing/prices.ts';
import type { UsageEvent } from '../schema/usage-event.ts';
import { batchEligible } from './batch-eligible.ts';
import { oversizedModel } from './oversized-model.ts';
import { retryStorm } from './retry-storm.ts';
import { truncatedOutput } from './truncated-output.ts';
import type { Analyzer, Finding } from './types.ts';
import { uncachedPrefix } from './uncached-prefix.ts';

export type { Analyzer, Finding, WasteKind } from './types.ts';

export const analyzers: Analyzer[] = [uncachedPrefix, oversizedModel, truncatedOutput, retryStorm, batchEligible];

export interface Analysis {
  events: number;
  /** Events that are rollups of many calls rather than one call each. */
  rollups: number;
  /** Estimated list-price spend on priced models. */
  spendUsd: number;
  /** Models with no entry in the price table; their findings report tokens only. */
  unpricedModels: string[];
  /** Ordered by estimated savings, largest first. */
  findings: Finding[];
}

export function analyze(events: UsageEvent[]): Analysis {
  let spendUsd = 0;
  const unpriced = new Set<string>();
  for (const e of events) {
    const cost = eventCost(e);
    if (cost === null) unpriced.add(e.model);
    else spendUsd += cost;
  }
  const findings = analyzers
    .flatMap((a) => a.run(events))
    .sort((a, b) => (b.savingsUsd ?? -1) - (a.savingsUsd ?? -1) || b.tokens - a.tokens);
  const rollups = events.filter((e) => e.granularity === 'aggregate').length;
  return { events: events.length, rollups, spendUsd, unpricedModels: [...unpriced].sort(), findings };
}
