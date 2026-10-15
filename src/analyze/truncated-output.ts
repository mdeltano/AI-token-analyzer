import { eventCost } from '../pricing/prices.ts';
import { totalTokens, type UsageEvent } from '../schema/usage-event.ts';
import { byProjectModel, fmtInt, metaNumber, metaString, promptTokens, quantile, type Analyzer, type Finding } from './types.ts';

const MIN_CALLS = 3;
const TRUNCATED = new Set(['max_tokens', 'length', 'max_output_tokens']);
/** A same-sized prompt this soon after a truncated call is taken to be its re-run. */
const RERUN_WINDOW_MS = 10 * 60_000;

/**
 * Calls cut off by their output limit. The cut-off call is waste when the caller re-runs it, which
 * is visible either from an explicit `retryOf` link or from a matching prompt shortly after.
 */
export const truncatedOutput: Analyzer = {
  kind: 'truncated-output',
  title: 'Output cut off by max_tokens and re-run',
  needs: 'meta.stopReason',
  run(events) {
    const findings: Finding[] = [];
    for (const calls of byProjectModel(events).values()) {
      const cut = calls.filter((e) => TRUNCATED.has(metaString(e, 'stopReason')?.toLowerCase() ?? ''));
      if (cut.length < MIN_CALLS) continue;

      const reruns = new Map<string, UsageEvent>();
      for (const e of calls) {
        const of = metaString(e, 'retryOf');
        if (of) reruns.set(of, e);
      }
      const sorted = [...calls].sort((a, b) => a.ts.localeCompare(b.ts));
      for (const c of cut) {
        if (reruns.has(c.dedupeKey)) continue;
        const at = Date.parse(c.ts);
        const next = sorted.find((e) =>
          e !== c && e.sessionId === c.sessionId && promptTokens(e) === promptTokens(c) &&
          Date.parse(e.ts) > at && Date.parse(e.ts) - at <= RERUN_WINDOW_MS);
        if (next) reruns.set(c.dedupeKey, next);
      }

      const wasted = cut.filter((c) => reruns.has(c.dedupeKey));
      const costs = wasted.map((e) => eventCost(e));
      const first = cut[0]!;
      const limits = [...new Set(cut.map((e) => metaNumber(e, 'maxTokens')).filter((n) => n !== undefined))];
      const needed = quantile(wasted.map((c) => reruns.get(c.dedupeKey)!.outputTokens), 0.95);
      const suggest = needed ? `Raise max_tokens to about ${fmtInt(Math.ceil(needed * 1.2 / 256) * 256)} (re-runs needed up to ${fmtInt(needed)} output tokens at p95)` : 'Raise max_tokens';
      findings.push({
        kind: 'truncated-output',
        project: first.project,
        model: first.model,
        events: cut.length,
        tokens: cut.reduce((n, e) => n + totalTokens(e), 0),
        savingsUsd: costs.includes(null) ? null : costs.reduce((n: number, c) => n + c!, 0),
        evidence: `${fmtInt(cut.length)} of ${fmtInt(calls.length)} calls stopped at the output limit` +
          `${limits.length ? ` (max_tokens ${limits.join(', ')})` : ''}, and ${fmtInt(wasted.length)} of those were sent again.`,
        recommendation: `${suggest}; a higher limit costs nothing on calls that finish early. ` +
          'Where long outputs are expected, stream the response or ask for a shorter format instead of re-running.',
      });
    }
    return findings;
  },
};
