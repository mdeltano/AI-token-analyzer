import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { totalTokens, usageEventSchema, type UsageEvent } from '../src/schema/usage-event.ts';
import { summarize } from '../src/report/summary.ts';
import { UsageStore } from '../src/store/db.ts';
import { generateWorkload, SYNTHETIC_SOURCE, type WasteKind } from '../src/synth/workload.ts';

const opts = { seed: 7, days: 14, end: '2026-10-13' };
const workload = generateWorkload(opts);
const planted = (kind: WasteKind) => workload.planted.find((p) => p.kind === kind)!;
const byProject = (project: string) => workload.events.filter((e) => e.project === project);
const sumTokens = (events: UsageEvent[]) => events.reduce((n, e) => n + totalTokens(e), 0);

describe('generateWorkload', () => {
  it('is reproducible for the same options and differs across seeds', () => {
    const again = generateWorkload(opts);
    assert.deepEqual(again.events, workload.events);
    assert.deepEqual(again.planted, workload.planted);
    const other = generateWorkload({ ...opts, seed: 8 });
    assert.notEqual(sumTokens(other.events), sumTokens(workload.events));
  });

  it('emits valid synthetic events inside the requested window', () => {
    for (const e of workload.events) usageEventSchema.parse(e);
    assert.ok(workload.events.every((e) => e.source === SYNTHETIC_SOURCE));
    assert.ok(workload.events[0]!.ts >= '2026-09-30T00:00:00.000Z');
    assert.ok(workload.events.at(-1)!.ts < '2026-10-14T00:00:00.000Z');
    assert.equal(new Set(workload.events.map((e) => e.dedupeKey)).size, workload.events.length);
  });

  it('plants each waste kind exactly once and leaves healthy features clean', () => {
    assert.deepEqual(workload.planted.map((p) => p.kind).sort(), [
      'batch-eligible', 'oversized-model', 'retry-storm', 'truncated-output', 'uncached-prefix',
    ]);
    const wasteful = new Set(workload.planted.map((p) => p.project));
    assert.ok(!wasteful.has('code-assistant') && !wasteful.has('search-rerank'));
    assert.ok(byProject('code-assistant').length > 0 && byProject('search-rerank').length > 0);
  });

  it('records a manifest that matches what is visible in the events', () => {
    const support = byProject('support-bot');
    assert.equal(planted('uncached-prefix').events, support.length);
    assert.ok(support.every((e) => e.cacheReadTokens === 0 && e.meta.promptPrefixHash === 'sp-support-v3'));

    const triage = byProject('ticket-triage');
    assert.equal(planted('oversized-model').events, triage.length);
    assert.equal(planted('oversized-model').tokens, sumTokens(triage));
    assert.ok(triage.every((e) => e.outputTokens <= 8 && e.model === 'claude-opus-5-5'));

    const truncated = byProject('doc-summarizer').filter((e) => e.meta.stopReason === 'max_tokens');
    assert.equal(planted('truncated-output').events, truncated.length);
    assert.equal(planted('truncated-output').tokens, sumTokens(truncated));
    const retried = new Set(byProject('doc-summarizer').map((e) => e.meta.retryOf));
    assert.ok(truncated.every((e) => retried.has(e.dedupeKey)), 'every truncated call is re-run');

    const retries = byProject('invoice-extractor').filter((e) => (e.meta.attempt as number) > 1);
    assert.ok(retries.length > 0);
    assert.equal(planted('retry-storm').events, retries.length);
    assert.equal(planted('retry-storm').tokens, sumTokens(retries));

    const digest = byProject('nightly-digest');
    assert.equal(planted('batch-eligible').events, digest.length);
    assert.ok(digest.every((e) => e.ts.slice(11, 13) < '06'), 'digest runs overnight');
  });

  it('scales volume', () => {
    const big = generateWorkload({ ...opts, scale: 2 });
    const ratio = big.events.length / workload.events.length;
    assert.ok(ratio > 1.8 && ratio < 2.2, `ratio ${ratio}`);
  });

  it('rejects bad options', () => {
    assert.throws(() => generateWorkload({ end: '10/13/2026' }), /YYYY-MM-DD/);
    assert.throws(() => generateWorkload({ days: 0 }), /days/);
    assert.throws(() => generateWorkload({ scale: Number.NaN }), /scale/);
  });

  it('stores idempotently', () => {
    const store = new UsageStore(':memory:');
    assert.equal(store.insert(workload.events), workload.events.length);
    assert.equal(store.insert(workload.events), 0);
    const [row] = summarize(store, 'source', { source: SYNTHETIC_SOURCE });
    assert.equal(row!.total, sumTokens(workload.events));
    store.close();
  });
});
