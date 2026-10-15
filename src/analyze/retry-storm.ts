import { totalTokens, type UsageEvent } from '../schema/usage-event.ts';
import { byProjectModel, fmtInt, groupBy, metaNumber, metaString, quantile, totalCost, type Analyzer, type Finding } from './types.ts';

const MIN_RETRIES = 3;
/** Identical requests further apart than this are treated as deliberate repeats, not retries. */
const RETRY_WINDOW_MS = 2 * 60_000;

/**
 * Identical requests (same `requestHash`) sent again within seconds: a client retrying calls that
 * the provider completed and billed, usually because its timeout is shorter than the model's
 * latency. Every attempt after the first is counted as waste.
 */
export const retryStorm: Analyzer = {
  kind: 'retry-storm',
  title: 'Client retries requests the provider already billed',
  needs: 'meta.requestHash',
  run(events) {
    const findings: Finding[] = [];
    for (const calls of byProjectModel(events).values()) {
      const retries: UsageEvent[] = [];
      const stormFirsts: UsageEvent[] = [];
      let storms = 0;
      let maxAttempts = 0;
      for (const same of groupBy(calls, (e) => metaString(e, 'requestHash')).values()) {
        same.sort((a, b) => a.ts.localeCompare(b.ts));
        const before = retries.length;
        let attempts = 1;
        for (let i = 1; i < same.length; i++) {
          if (Date.parse(same[i]!.ts) - Date.parse(same[i - 1]!.ts) <= RETRY_WINDOW_MS) {
            retries.push(same[i]!);
            attempts++;
          } else {
            attempts = 1;
          }
          maxAttempts = Math.max(maxAttempts, attempts);
        }
        if (retries.length > before) {
          storms++;
          stormFirsts.push(same[0]!);
        }
      }
      if (retries.length < MIN_RETRIES) continue;

      const first = calls[0]!;
      const latencies = calls.map((e) => metaNumber(e, 'latencyMs')).filter((n) => n !== undefined);
      const stormLatency = stormFirsts.map((e) => metaNumber(e, 'latencyMs')).filter((n) => n !== undefined);
      const timeout = latencies.length
        ? `Set the client timeout above the p99 latency (${(quantile(latencies, 0.99) / 1000).toFixed(1)}s` +
          (stormLatency.length ? `; requests that were retried took a median ${(quantile(stormLatency, 0.5) / 1000).toFixed(1)}s` : '') + ')'
        : 'Set the client timeout above the p99 latency of this call';
      findings.push({
        kind: 'retry-storm',
        project: first.project,
        model: first.model,
        events: retries.length,
        tokens: retries.reduce((n, e) => n + totalTokens(e), 0),
        savingsUsd: totalCost(retries),
        evidence: `${fmtInt(storms)} requests were sent more than once within ${RETRY_WINDOW_MS / 60_000} minutes ` +
          `(up to ${maxAttempts} attempts each), adding ${fmtInt(retries.length)} billed calls.`,
        recommendation: `${timeout}, and retry only on rate-limit or server errors, with exponential backoff and a cap of 2 retries.`,
      });
    }
    return findings;
  },
};
