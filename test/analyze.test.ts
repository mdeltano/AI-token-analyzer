import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeEvent } from '../src/adapters/event.ts';
import { analyze, analyzers } from '../src/analyze/index.ts';
import { canonicalModel, eventCost, priceFor, tokenCost } from '../src/pricing/prices.ts';
import type { UsageEvent } from '../src/schema/usage-event.ts';
import { UsageStore } from '../src/store/db.ts';
import { generateWorkload } from '../src/synth/workload.ts';

const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe('prices', () => {
  it('folds platform and snapshot spellings into the first-party id', () => {
    for (const id of ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'anthropic/claude-opus-5-5', 'us.anthropic.claude-opus-5-5-v1:0', 'claude-opus-5-5@20260401']) {
      assert.equal(canonicalModel(id), 'claude-opus-5-5', id);
    }
    assert.equal(canonicalModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
    assert.equal(priceFor('some-local-model'), undefined);
  });

  it('prices every token type', () => {
    const opus = priceFor('claude-opus-5-5')!;
    const M = 1_000_000;
    assert.equal(tokenCost({ ...zero, inputTokens: M }, opus), 4);
    assert.equal(tokenCost({ ...zero, outputTokens: M }, opus), 20);
    assert.equal(tokenCost({ ...zero, cacheReadTokens: M }, opus), 0.2);
    assert.equal(tokenCost({ ...zero, cacheWriteTokens: M }, opus), 5);
    assert.equal(tokenCost({ ...zero, cacheWriteTokens: M, cacheWrite1hTokens: M }, opus), 8);
  });

  it('switches to long-context rates past the threshold', () => {
    const haiku = priceFor('claude-haiku-5-5')!;
    assert.equal(tokenCost({ ...zero, inputTokens: 100_000 }, haiku), 0.01);
    assert.equal(tokenCost({ ...zero, inputTokens: 100_001 }, haiku), 100_001 * 0.5 / 1e6);
  });

  it('discounts batch-tier events and returns null for unknown models', () => {
    const base = { dedupeKey: 'k', source: 's', ts: '2026-10-01T00:00:00.000Z', sourceFile: 'f', inputTokens: 1_000_000 };
    assert.equal(eventCost(makeEvent({ ...base, model: 'claude-sonnet-5-5', meta: { serviceTier: 'batch' } })), 1);
    assert.equal(eventCost(makeEvent({ ...base, model: 'mystery-1' })), null);
  });
});

describe('analyze on the synthetic workload', () => {
  for (const seed of [7, 42]) {
    const workload = generateWorkload({ seed, days: 21, end: '2026-10-13' });
    const result = analyze(workload.events);

    it(`finds exactly the planted waste (seed ${seed})`, () => {
      const found = result.findings.map((f) => ({ kind: f.kind, project: f.project, model: f.model, events: f.events, tokens: f.tokens }));
      const planted = workload.planted.map((p) => ({ kind: p.kind, project: p.project, model: p.model, events: p.events, tokens: p.tokens }));
      const order = (a: { kind: string }, b: { kind: string }) => a.kind.localeCompare(b.kind);
      assert.deepEqual(found.sort(order), planted.sort(order));
    });

    it(`prices every finding and orders by savings (seed ${seed})`, () => {
      assert.deepEqual(result.unpricedModels, []);
      const savings = result.findings.map((f) => f.savingsUsd!);
      assert.ok(savings.every((s) => s > 0));
      assert.deepEqual(savings, [...savings].sort((a, b) => b - a));
      assert.ok(savings.reduce((a, b) => a + b, 0) < result.spendUsd);
    });
  }

  it('suggests a concrete fix for each kind', () => {
    const { findings } = analyze(generateWorkload({ seed: 42, days: 14, end: '2026-10-13' }).events);
    const fix = (kind: string) => findings.find((f) => f.kind === kind)!.recommendation;
    assert.match(fix('uncached-prefix'), /cache_control/);
    assert.match(fix('oversized-model'), /claude-haiku-5-5/);
    assert.match(fix('truncated-output'), /max_tokens to about [\d,]+/);
    assert.match(fix('retry-storm'), /timeout above the p99 latency \(\d+\.\ds/);
    assert.match(fix('batch-eligible'), /Message Batches/);
  });

  it('round-trips events through the store unchanged', () => {
    const { events } = generateWorkload({ seed: 3, days: 2, end: '2026-10-13' });
    const store = new UsageStore(':memory:');
    store.insert(events);
    assert.deepEqual(store.events({ source: 'synthetic' }), events);
    assert.deepEqual(store.events({ since: '2026-10-13' }), events.filter((e) => e.ts >= '2026-10-13'));
    store.close();
  });
});

describe('analyzers on healthy traffic', () => {
  let n = 0;
  const call = (fields: Partial<UsageEvent> & { at: number }): UsageEvent =>
    makeEvent({
      dedupeKey: `t:${n++}`, source: 'test', model: 'claude-opus-5-5', sourceFile: 'f', project: 'p',
      ts: new Date(Date.UTC(2026, 9, 1) + fields.at * 1000).toISOString(), ...fields,
    });

  it('does not flag an agent loop with short tool calls and cached context', () => {
    const events = Array.from({ length: 80 }, (_, i) => call({
      at: i * 20, sessionId: 's1', inputTokens: 3, cacheReadTokens: 20_000 + i * 900, cacheWriteTokens: 900, outputTokens: 12,
      meta: { stopReason: i === 79 ? 'end_turn' : 'tool_use' },
    }));
    assert.deepEqual(analyze(events).findings, []);
  });

  it('does not count identical requests hours apart as retries', () => {
    const events = Array.from({ length: 10 }, (_, i) => call({
      at: i * 3 * 3600, inputTokens: 2000, outputTokens: 300, meta: { requestHash: 'same', stopReason: 'end_turn' },
    }));
    assert.deepEqual(analyze(events).findings, []);
  });

  it('does not count truncated calls that nobody re-ran as waste', () => {
    const events = Array.from({ length: 5 }, (_, i) => call({
      at: i * 3600, model: 'claude-sonnet-5-5', inputTokens: 3000 + i, outputTokens: 400, meta: { stopReason: 'max_tokens', maxTokens: 400 },
    }));
    const [finding] = analyzers.find((a) => a.kind === 'truncated-output')!.run(events);
    assert.equal(finding!.savingsUsd, 0);
    assert.match(finding!.evidence, /0 of those were sent again/);
  });
});
