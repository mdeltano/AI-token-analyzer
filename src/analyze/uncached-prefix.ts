import { priceFor, tokenCost } from '../pricing/prices.ts';
import { byProjectModel, fmtInt, groupBy, metaNumber, metaString, promptTokens, type Analyzer, type Finding } from './types.ts';

const MIN_CALLS = 20;
/** Below this, a prefix may be under the provider's minimum cacheable length. */
const MIN_PREFIX = 1024;
/** A group whose input side is under this share cache reads is treated as not caching. */
const MAX_HIT_RATE = 0.05;
/** Default cache lifetime; a call within this long of the previous one would find the prefix warm. */
const TTL_MS = 5 * 60_000;

/**
 * Calls that share a prompt prefix (same `promptPrefixHash`) but never read it from the cache. The
 * prefix size is `systemPromptTokens` when the source records it, else the shortest prompt in the
 * group, which the shared prefix cannot exceed.
 */
export const uncachedPrefix: Analyzer = {
  kind: 'uncached-prefix',
  title: 'Repeated prompt prefix is not cached',
  needs: 'meta.promptPrefixHash',
  run(events) {
    const findings: Finding[] = [];
    for (const group of byProjectModel(events).values()) {
      for (const [hash, calls] of groupBy(group, (e) => metaString(e, 'promptPrefixHash'))) {
        if (calls.length < MIN_CALLS) continue;
        const inputSide = calls.reduce((n, e) => n + promptTokens(e), 0);
        const read = calls.reduce((n, e) => n + e.cacheReadTokens, 0);
        if (!inputSide || read / inputSide >= MAX_HIT_RATE) continue;

        const prefix = Math.min(...calls.map((e) => metaNumber(e, 'systemPromptTokens') ?? promptTokens(e)));
        if (prefix < MIN_PREFIX) continue;

        // a call within the TTL of the previous one would have read the prefix; the rest would write it
        const sorted = [...calls].sort((a, b) => a.ts.localeCompare(b.ts));
        let warm = 0;
        for (let i = 1; i < sorted.length; i++) {
          if (Date.parse(sorted[i]!.ts) - Date.parse(sorted[i - 1]!.ts) <= TTL_MS) warm++;
        }
        const cold = calls.length - warm;

        const first = calls[0]!;
        const price = priceFor(first.model);
        // cost of the prefix billed as each token type
        const as = (type: 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens') =>
          tokenCost({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, [type]: prefix }, price!);
        const savingsUsd = price
          ? Math.max(0, warm * (as('inputTokens') - as('cacheReadTokens')) - cold * (as('cacheWriteTokens') - as('inputTokens')))
          : null;

        const how = first.vendor === 'anthropic'
          ? 'Put a cache_control breakpoint at the end of the shared system prompt and tool definitions'
          : 'Caching is automatic on this provider, so the prefix must be changing between calls: move per-request content (timestamps, IDs, user data) after the shared instructions';
        findings.push({
          kind: 'uncached-prefix',
          project: first.project,
          model: first.model,
          events: calls.length,
          tokens: prefix * calls.length,
          savingsUsd,
          evidence: `${fmtInt(calls.length)} calls share a ~${fmtInt(prefix)}-token prefix (${hash}) and ${fmtInt(read)} tokens were read from cache; ` +
            `${Math.round((warm / calls.length) * 100)}% of calls came within 5 minutes of the previous one and would have hit a warm cache.`,
          recommendation: `${how}. Then confirm cache-read tokens appear on repeat calls.`,
        });
      }
    }
    return findings;
  },
};
