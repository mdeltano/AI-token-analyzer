import { priceFor, tokenCost } from '../pricing/prices.ts';
import { totalTokens } from '../schema/usage-event.ts';
import { byProjectModel, fmtInt, metaString, quantile, totalCost, type Analyzer, type Finding } from './types.ts';

const MIN_CALLS = 20;
/** Output lengths at or under these look like labels, scores or IDs rather than generated text. */
const MAX_MEDIAN_OUTPUT = 16;
const MAX_P90_OUTPUT = 32;
/** Agent loops end most turns in a short tool call, so short outputs there don't mean a simple task. */
const MAX_TOOL_USE_SHARE = 0.1;

/**
 * A frontier or mid-tier model answering with a few tokens per call: classification, routing or
 * extraction that a small model in the same family usually handles. Savings reprice the same
 * token counts at the smaller model; the quality trade-off still needs an eval on real traffic.
 */
export const oversizedModel: Analyzer = {
  kind: 'oversized-model',
  title: 'Short-answer task on a larger model than it needs',
  needs: 'output token counts (any source)',
  run(events) {
    const findings: Finding[] = [];
    for (const calls of byProjectModel(events).values()) {
      const first = calls[0]!;
      const price = priceFor(first.model);
      const target = price?.downshift && priceFor(price.downshift);
      if (!price || !target || calls.length < MIN_CALLS) continue;

      const outputs = calls.map((e) => e.outputTokens);
      const median = quantile(outputs, 0.5);
      const p90 = quantile(outputs, 0.9);
      const toolUse = calls.filter((e) => metaString(e, 'stopReason') === 'tool_use').length;
      if (median > MAX_MEDIAN_OUTPUT || p90 > MAX_P90_OUTPUT || toolUse / calls.length > MAX_TOOL_USE_SHARE) continue;

      const current = totalCost(calls)!;
      const downshifted = calls.reduce((n, e) => n + tokenCost(e, target), 0);
      findings.push({
        kind: 'oversized-model',
        project: first.project,
        model: first.model,
        events: calls.length,
        tokens: calls.reduce((n, e) => n + totalTokens(e), 0),
        savingsUsd: Math.max(0, current - downshifted),
        evidence: `${fmtInt(calls.length)} calls on a ${price.tier} model return a median of ${median} output tokens (p90 ${p90}), ` +
          `the shape of classification or routing rather than generation.`,
        recommendation: `Run this task on ${target.model}: evaluate it against a labelled sample of recent calls first, ` +
          `and keep ${first.model} as a fallback for low-confidence cases if the small model's accuracy falls short.`,
      });
    }
    return findings;
  },
};
