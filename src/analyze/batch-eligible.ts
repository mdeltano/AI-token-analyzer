import { priceFor } from '../pricing/prices.ts';
import { totalTokens, type UsageEvent } from '../schema/usage-event.ts';
import { byProjectModel, fmtInt, groupBy, metaString, promptTokens, quantile, totalCost, type Analyzer, type Finding } from './types.ts';

const SCHEDULED = new Set(['cron', 'schedule', 'scheduled', 'job']);
/** An unlabelled session needs at least this many calls to count as a bulk run. */
const MIN_RUN_CALLS = 50;
const MAX_TOOL_USE_SHARE = 0.1;
/** If the last prompt is this much larger than the median, context is accumulating across calls. */
const MAX_PROMPT_GROWTH = 2;

/**
 * Bulk runs of independent requests sent synchronously: either labelled as scheduled
 * (`meta.trigger`), or a large session whose calls neither use tools nor build on one another's
 * context. Nobody waits on these, so the batch API's discount applies to every token.
 */
export const batchEligible: Analyzer = {
  kind: 'batch-eligible',
  title: 'Bulk job could use the batch API',
  needs: 'session IDs, or meta.trigger',
  run(events) {
    const findings: Finding[] = [];
    for (const calls of byProjectModel(events).values()) {
      const first = calls[0]!;
      const price = priceFor(first.model);
      // scheduled calls without a session are grouped into one run per day
      const runs = [...groupBy(calls, (e) => e.sessionId ?? (isScheduled(e) ? `scheduled:${e.ts.slice(0, 10)}` : undefined)).values()]
        .filter(isBulkRun);
      if (!runs.length) continue;

      const affected = runs.flat();
      const cost = totalCost(affected);
      const starts = runs.map((r) => Math.min(...r.map((e) => Date.parse(e.ts))));
      const hour = new Date(quantile(starts.map((t) => t % 86_400_000), 0.5)).toISOString().slice(11, 16);
      const discount = price?.batchDiscount ?? 0.5;
      findings.push({
        kind: 'batch-eligible',
        project: first.project,
        model: first.model,
        events: affected.length,
        tokens: affected.reduce((n, e) => n + totalTokens(e), 0),
        savingsUsd: cost === null ? null : cost * discount,
        evidence: `${fmtInt(runs.length)} runs of ~${fmtInt(affected.length / runs.length)} independent calls each, ` +
          `typically starting around ${hour} UTC, all sent synchronously at standard pricing.`,
        recommendation: `Submit each run through the ${first.vendor === 'anthropic' ? 'Message Batches' : 'Batch'} API for ` +
          `${Math.round(discount * 100)}% off every token; results usually arrive well within an hour and always within 24.`,
      });
    }
    return findings;
  },
};

const isScheduled = (e: UsageEvent) => SCHEDULED.has(metaString(e, 'trigger') ?? '');

function isBulkRun(run: UsageEvent[]): boolean {
  if (run.some((e) => metaString(e, 'serviceTier') === 'batch')) return false;
  if (run.some(isScheduled)) return true;
  if (run.length < MIN_RUN_CALLS) return false;
  const toolUse = run.filter((e) => metaString(e, 'stopReason') === 'tool_use').length;
  if (toolUse / run.length > MAX_TOOL_USE_SHARE) return false;
  const last = run.reduce((a, b) => (b.ts > a.ts ? b : a));
  return promptTokens(last) <= MAX_PROMPT_GROWTH * quantile(run.map(promptTokens), 0.5);
}
