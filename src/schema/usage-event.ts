import { z } from 'zod';

/**
 * One normalized unit of LLM usage. Every source adapter emits these.
 *
 * Token semantics are normalized to the Anthropic convention regardless of source:
 * - `inputTokens` excludes cached tokens (fresh, full-price input only)
 * - `cacheReadTokens` / `cacheWriteTokens` are reported separately
 * - `outputTokens` is all billable output, including reasoning
 * - `reasoningTokens` is the reasoning subset of `outputTokens`
 */
export const usageEventSchema = z.object({
  /** Globally unique per real-world call; re-importing the same file must produce the same key. */
  dedupeKey: z.string().min(1),
  source: z.string().min(1),
  vendor: z.string().min(1),
  model: z.string().min(1),
  ts: z.iso.datetime(),
  sessionId: z.string().nullable(),
  project: z.string().nullable(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  reasoningTokens: z.int().nonnegative(),
  cacheReadTokens: z.int().nonnegative(),
  cacheWriteTokens: z.int().nonnegative(),
  /** Cost as recorded by the source, when it records one. Estimated cost is computed later. */
  recordedCostUsd: z.number().nonnegative().nullable(),
  /** `request` = one model call; `aggregate` = a rollup (e.g. per-session totals). */
  granularity: z.enum(['request', 'aggregate']),
  sourceFile: z.string(),
  meta: z.record(z.string(), z.unknown()),
});

export type UsageEvent = z.infer<typeof usageEventSchema>;

export function totalTokens(e: Pick<UsageEvent, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  return e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
}
