import { eventCost } from '../pricing/prices.ts';
import type { UsageEvent } from '../schema/usage-event.ts';

export type WasteKind = 'uncached-prefix' | 'oversized-model' | 'truncated-output' | 'retry-storm' | 'batch-eligible';

/** One kind of waste found in one project's use of one model. */
export interface Finding {
  kind: WasteKind;
  project: string | null;
  model: string;
  /** Calls affected by the waste. */
  events: number;
  /** Tokens on those calls that the waste accounts for. */
  tokens: number;
  /** Estimated USD the fix would have saved over the analyzed period; null when the model has no price. */
  savingsUsd: number | null;
  /** What in the data shows the waste. */
  evidence: string;
  recommendation: string;
}

export interface Analyzer {
  kind: WasteKind;
  title: string;
  /** Request-level fields the analyzer depends on, for explaining why a source yields no findings. */
  needs: string;
  run(events: UsageEvent[]): Finding[];
}

/** Group events by project and model, the unit every finding is reported at. */
export function byProjectModel(events: Iterable<UsageEvent>): Map<string, UsageEvent[]> {
  return groupBy(events, (e) => `${e.project ?? ''}\u0000${e.model}`);
}

export function groupBy<T>(items: Iterable<T>, key: (item: T) => string | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === undefined) continue;
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/** Value at quantile `q` (0..1) of `values`, by nearest rank. */
export function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

/** Sum of estimated list-price cost, or null if any event's model has no price. */
export function totalCost(events: UsageEvent[]): number | null {
  let sum = 0;
  for (const e of events) {
    const c = eventCost(e);
    if (c === null) return null;
    sum += c;
  }
  return sum;
}

export const metaString = (e: UsageEvent, key: string): string | undefined =>
  typeof e.meta[key] === 'string' && e.meta[key] !== '' ? (e.meta[key] as string) : undefined;

export const metaNumber = (e: UsageEvent, key: string): number | undefined =>
  typeof e.meta[key] === 'number' && Number.isFinite(e.meta[key]) ? (e.meta[key] as number) : undefined;

export const promptTokens = (e: UsageEvent) => e.inputTokens + e.cacheReadTokens + e.cacheWriteTokens;

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');
