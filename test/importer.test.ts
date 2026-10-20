import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { claudeCode } from '../src/adapters/claude-code.ts';
import { importAll } from '../src/importer.ts';
import { summarize } from '../src/report/summary.ts';
import { UsageStore } from '../src/store/db.ts';
import { jsonl, tmpTree } from './helpers.ts';

const line = (id: string) =>
  jsonl({
    type: 'assistant',
    requestId: `r_${id}`,
    sessionId: 's',
    timestamp: '2026-10-14T10:00:00Z',
    message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 90, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 } },
  });

describe('importAll', () => {
  it('is idempotent and picks up appended lines', () => {
    const root = tmpTree({ 'p/s.jsonl': line('m1') });
    const store = new UsageStore(':memory:');
    const ctx = { home: root, env: {} };
    const opts = { adapters: [claudeCode], roots: [root] };

    assert.equal(importAll(store, ctx, opts)[0]!.eventsAdded, 1);
    const again = importAll(store, ctx, opts)[0]!;
    assert.equal(again.filesParsed, 0, 'unchanged file is skipped');

    appendFileSync(join(root, 'p', 's.jsonl'), line('m2'));
    assert.equal(importAll(store, ctx, opts)[0]!.eventsAdded, 1);
    assert.equal(importAll(store, ctx, { ...opts, full: true })[0]!.eventsAdded, 0, 'full re-read adds no duplicates');

    const [row] = summarize(store, 'source');
    assert.equal(row!.events, 2);
    assert.equal(row!.total, 2200);
    assert.equal(row!.cacheHitRate, 1800 / 2020);
    store.close();
  });

  it('completes a message first imported mid-response', () => {
    const msg = (output: number, stop: string | null) => jsonl({
      type: 'assistant',
      requestId: 'r_m1',
      sessionId: 's',
      timestamp: '2026-10-14T10:00:00Z',
      message: { id: 'm1', model: 'claude-opus-5-5', stop_reason: stop, usage: { input_tokens: 10, output_tokens: output } },
    });
    const root = tmpTree({ 'p/s.jsonl': msg(5, null) });
    const store = new UsageStore(':memory:');
    const opts = { adapters: [claudeCode], roots: [root] };
    importAll(store, { home: root, env: {} }, opts);

    appendFileSync(join(root, 'p', 's.jsonl'), msg(400, 'end_turn'));
    assert.equal(importAll(store, { home: root, env: {} }, opts)[0]!.eventsAdded, 0);
    const [event, ...rest] = store.events();
    assert.equal(rest.length, 0);
    assert.equal(event!.outputTokens, 400);
    assert.equal(event!.meta.stopReason, 'end_turn');
    store.close();
  });
});
