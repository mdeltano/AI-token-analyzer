import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { amp } from '../src/adapters/amp.ts';
import { claudeCode } from '../src/adapters/claude-code.ts';
import { codex } from '../src/adapters/codex.ts';
import { copilotCli } from '../src/adapters/copilot-cli.ts';
import { gemini } from '../src/adapters/gemini.ts';
import { opencode } from '../src/adapters/opencode.ts';
import { otel } from '../src/adapters/otel.ts';
import { qwen } from '../src/adapters/qwen.ts';
import type { SourceAdapter } from '../src/adapters/types.ts';
import { usageEventSchema } from '../src/schema/usage-event.ts';
import { jsonl, tmpTree } from './helpers.ts';

function parseAll(adapter: SourceAdapter, root: string) {
  const events = adapter.discover(root).flatMap((f) => adapter.parse(f));
  for (const e of events) usageEventSchema.parse(e);
  return events;
}

const counts = (e: { inputTokens: number; outputTokens: number; reasoningTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) => ({
  input: e.inputTokens,
  output: e.outputTokens,
  reasoning: e.reasoningTokens,
  cacheRead: e.cacheReadTokens,
  cacheWrite: e.cacheWriteTokens,
});

describe('claude-code', () => {
  const assistant = (id: string, block: string, model = 'claude-opus-5-5') => ({
    type: 'assistant',
    requestId: `req_${id}`,
    sessionId: 's1',
    cwd: 's:\\work\\app',
    timestamp: '2026-10-14T10:00:00.000Z',
    message: {
      id,
      model,
      content: [{ type: block }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 200, output_tokens_details: { thinking_tokens: 50 }, cache_read_input_tokens: 1000, cache_creation_input_tokens: 400 },
    },
  });

  it('counts one event per message even when it spans several lines', () => {
    const root = tmpTree({
      'proj/s1.jsonl': jsonl({ type: 'user', message: { content: 'hi' } }, assistant('msg_1', 'thinking'), assistant('msg_1', 'text'), assistant('msg_2', 'text')) + '{"truncated":',
      'proj/s1/subagents/agent-a1.jsonl': jsonl(assistant('msg_3', 'text')),
    });
    const events = parseAll(claudeCode, root);
    assert.equal(events.length, 3);
    assert.deepEqual(counts(events[0]!), { input: 3, output: 200, reasoning: 50, cacheRead: 1000, cacheWrite: 400 });
    assert.equal(events[0]!.vendor, 'anthropic');
    assert.equal(events[0]!.project, 'S:\\work\\app');
    assert.equal(events.filter((e) => e.meta.subagent).length, 1);
  });

  it('skips synthetic messages', () => {
    const root = tmpTree({ 'p/s.jsonl': jsonl(assistant('msg_x', 'text', '<synthetic>')) });
    assert.equal(parseAll(claudeCode, root).length, 0);
  });

  it('honors CLAUDE_CONFIG_DIR', () => {
    assert.deepEqual(claudeCode.defaultRoots({ home: '/h', env: { CLAUDE_CONFIG_DIR: '/a, /b' } }), [join('/a', 'projects'), join('/b', 'projects')]);
  });
});

describe('codex', () => {
  const tokenCount = (ts: string, total: object, last: object | null) => ({
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 272000 } },
  });
  const t1 = { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 1300 };
  const t2 = { input_tokens: 2500, cached_input_tokens: 1800, output_tokens: 500, reasoning_output_tokens: 150, total_tokens: 3000 };

  const rollout = jsonl(
    { timestamp: '2026-10-14T10:00:00Z', type: 'session_meta', payload: { id: 'sess-1', cwd: '/work/app' } },
    { timestamp: '2026-10-14T10:00:01Z', type: 'turn_context', payload: { model: 'gpt-5.5-codex' } },
    tokenCount('2026-10-14T10:00:05Z', t1, t1),
    tokenCount('2026-10-14T10:00:06Z', t1, t1), // re-emission
    tokenCount('2026-10-14T10:01:00Z', t2, null), // no last_token_usage: delta from cumulative
  );

  it('normalizes OpenAI counts and drops re-emitted snapshots', () => {
    const events = parseAll(codex, tmpTree({ '2026/10/14/rollout-2026-10-14T10-00-00-sess-1.jsonl': rollout }));
    assert.equal(events.length, 2);
    assert.deepEqual(counts(events[0]!), { input: 400, output: 300, reasoning: 100, cacheRead: 600, cacheWrite: 0 });
    assert.deepEqual(counts(events[1]!), { input: 300, output: 200, reasoning: 50, cacheRead: 1200, cacheWrite: 0 });
    assert.equal(events[0]!.model, 'gpt-5.5-codex');
    assert.equal(events[0]!.vendor, 'openai');
    assert.equal(events[0]!.sessionId, 'sess-1');
  });

  it('produces stable keys across re-parses', () => {
    const root = tmpTree({ 'rollout-a.jsonl': rollout });
    assert.deepEqual(parseAll(codex, root).map((e) => e.dedupeKey), parseAll(codex, root).map((e) => e.dedupeKey));
  });
});

describe('gemini-cli', () => {
  const msg = (id: string, tokens: object | undefined) => ({ id, type: 'gemini', timestamp: '2026-10-14T09:00:00Z', model: 'gemini-3-pro', content: 'x', tokens });
  const tokens = { input: 5000, output: 400, cached: 3000, thoughts: 250, tool: 10, total: 5650 };

  it('reads single-document sessions', () => {
    const doc = { sessionId: 'g1', projectHash: 'abc', startTime: '2026-10-14T08:59:00Z', messages: [{ id: 'u', type: 'user', content: 'hi' }, msg('m1', tokens)] };
    const events = parseAll(gemini, tmpTree({ 'abc/chats/session-1.json': JSON.stringify(doc) }));
    assert.equal(events.length, 1);
    assert.deepEqual(counts(events[0]!), { input: 2000, output: 650, reasoning: 250, cacheRead: 3000, cacheWrite: 0 });
    assert.equal(events[0]!.vendor, 'google');
  });

  it('reads JSONL sessions, keeping the last version of each message', () => {
    const body = jsonl({ sessionId: 'g2', startTime: '2026-10-14T08:59:00Z' }, msg('m1', undefined), msg('m1', tokens), msg('m2', tokens));
    const events = parseAll(gemini, tmpTree({ 'abc/chats/session-2.jsonl': body, 'abc/logs.json': '[]' }));
    assert.equal(events.length, 2);
    assert.equal(events[0]!.sessionId, 'g2');
  });
});

describe('qwen-code', () => {
  it('subtracts cached tokens from the prompt count', () => {
    const body = jsonl(
      { type: 'user', uuid: 'u1', sessionId: 'q1', message: { parts: [{ text: 'hi' }] } },
      { type: 'assistant', uuid: 'a1', sessionId: 'q1', timestamp: '2026-10-14T09:00:00Z', model: 'qwen3-coder-plus', usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 100, cachedContentTokenCount: 500, thoughtsTokenCount: 20 } },
      { type: 'assistant', uuid: 'a2', sessionId: 'q1', timestamp: '2026-10-14T09:00:00Z', model: 'qwen3-coder-plus' },
    );
    const events = parseAll(qwen, tmpTree({ '-work-app/chats/q1.jsonl': body }));
    assert.equal(events.length, 1);
    assert.deepEqual(counts(events[0]!), { input: 400, output: 120, reasoning: 20, cacheRead: 500, cacheWrite: 0 });
    assert.equal(events[0]!.vendor, 'alibaba');
  });
});

describe('opencode', () => {
  const data = (role: string) => ({
    role,
    modelID: 'claude-sonnet-5-5',
    providerID: 'anthropic',
    time: { created: 1760432400000 },
    cost: 0.0123,
    tokens: { input: 50, output: 300, reasoning: 40, cache: { read: 7000, write: 900 } },
  });

  it('reads legacy JSON message files', () => {
    const root = tmpTree({
      'storage/message/ses_1/msg_1.json': JSON.stringify({ id: 'msg_1', sessionID: 'ses_1', ...data('assistant') }),
      'storage/message/ses_1/msg_0.json': JSON.stringify({ id: 'msg_0', sessionID: 'ses_1', ...data('user') }),
    });
    const events = parseAll(opencode, root);
    assert.equal(events.length, 1);
    assert.deepEqual(counts(events[0]!), { input: 50, output: 340, reasoning: 40, cacheRead: 7000, cacheWrite: 900 });
    assert.equal(events[0]!.recordedCostUsd, 0.0123);
  });

  it('reads both SQLite generations without double-counting migrated rows', () => {
    const root = tmpTree({});
    const db = new DatabaseSync(join(root, 'opencode.db'));
    db.exec(`CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data BLOB);
             CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data BLOB);`);
    const legacy = JSON.stringify(data('assistant'));
    const { role: _, modelID: __, providerID: ___, ...rest } = data('assistant');
    const v2 = JSON.stringify({ ...rest, model: { id: 'claude-sonnet-5-5', providerID: 'anthropic' } });
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m1', 'ses_1', 1760432400000, legacy);
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run('m1', 'ses_1', 'assistant', 1, 1760432400000, v2);
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run('m2', 'ses_1', 'assistant', 2, 1760432460000, v2);
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run('m3', 'ses_1', 'user', 3, 1760432460000, '{"text":"hi"}');
    db.close();

    const events = parseAll(opencode, root);
    assert.deepEqual(events.map((e) => e.dedupeKey), ['opencode:ses_1:m1', 'opencode:ses_1:m2']);
    assert.equal(events[1]!.vendor, 'anthropic');
  });

  it('finds the database under a root spelled with forward slashes and a trailing slash', () => {
    const root = tmpTree({});
    const db = new DatabaseSync(join(root, 'opencode.db'));
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data BLOB);');
    db.close();
    assert.equal(opencode.discover(`${root.replaceAll('\\', '/')}/`).length, 1);
  });
});

describe('amp', () => {
  it('prefers the usage ledger and joins cache counts from the linked message', () => {
    const thread = {
      id: 'T-1',
      messages: [
        { role: 'user', messageId: 0, content: [] },
        { role: 'assistant', messageId: 1, usage: { model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 99, cacheReadInputTokens: 4000, cacheCreationInputTokens: 600 } },
      ],
      usageLedger: { events: [{ id: 'ev1', timestamp: '2026-10-14T09:00:00Z', model: 'claude-sonnet-5-5', toMessageId: 1, credits: 2, tokens: { input: 10, output: 100, total: 4710 } }] },
    };
    const events = parseAll(amp, tmpTree({ 'T-1.json': JSON.stringify(thread) }));
    assert.equal(events.length, 1);
    assert.deepEqual(counts(events[0]!), { input: 10, output: 100, reasoning: 0, cacheRead: 4000, cacheWrite: 600 });
  });

  it('falls back to assistant usage blocks', () => {
    const thread = {
      id: 'T-2',
      messages: [{ role: 'assistant', messageId: 1, model: 'claude-sonnet-5-5', usage: { timestamp: '2026-10-14T09:00:00Z', inputTokens: 5, outputTokens: 50, cacheReadInputTokens: 100 } }],
    };
    const events = parseAll(amp, tmpTree({ 'T-2.json': JSON.stringify(thread) }));
    assert.deepEqual(counts(events[0]!), { input: 5, output: 50, reasoning: 0, cacheRead: 100, cacheWrite: 0 });
  });
});

describe('copilot-cli', () => {
  const shutdown = (ts: string, usage: object) => ({
    type: 'session.shutdown',
    timestamp: ts,
    data: { modelMetrics: { 'claude-sonnet-5-5': { requests: { count: 3 }, usage } } },
  });

  it('stores each shutdown as a delta from the previous cumulative rollup', () => {
    const body = jsonl(
      { type: 'session.start', timestamp: '2026-10-14T09:00:00Z', data: { context: { cwd: '/work/app' } } },
      shutdown('2026-10-14T09:30:00Z', { inputTokens: 10000, outputTokens: 800, cacheReadTokens: 7000, cacheWriteTokens: 1000, reasoningTokens: 0 }),
      shutdown('2026-10-14T10:30:00Z', { inputTokens: 15000, outputTokens: 1200, cacheReadTokens: 11000, cacheWriteTokens: 1500, reasoningTokens: 0 }),
    );
    const events = parseAll(copilotCli, tmpTree({ 'abc-123/events.jsonl': body }));
    assert.equal(events.length, 2);
    assert.deepEqual(counts(events[0]!), { input: 2000, output: 800, reasoning: 0, cacheRead: 7000, cacheWrite: 1000 });
    assert.deepEqual(counts(events[1]!), { input: 500, output: 400, reasoning: 0, cacheRead: 4000, cacheWrite: 500 });
    assert.equal(events[0]!.granularity, 'aggregate');
    assert.equal(events[0]!.sessionId, 'abc-123');
    assert.equal(events[0]!.project, '/work/app');
  });
});

describe('otel', () => {
  type Value = string | number | boolean | string[];
  const kv = (o: Record<string, Value>) => Object.entries(o).map(([key, v]) => ({
    key,
    value: Array.isArray(v) ? { arrayValue: { values: v.map((s) => ({ stringValue: s })) } }
      : typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v })
      : typeof v === 'boolean' ? { boolValue: v } : { stringValue: v },
  }));
  const start = 1_791_972_000_000_000_000; // 2026-10-14T10:00:00Z
  const span = (id: string, a: Record<string, Value>, ms = 1500) => ({
    traceId: '5B8EFFF798038103D269B633813FC60C', spanId: id, name: `chat ${a['gen_ai.request.model']}`, kind: 3,
    startTimeUnixNano: String(start), endTimeUnixNano: String(start + ms * 1e6), attributes: kv(a),
  });
  const traces = (...spans: object[]) => ({
    resourceSpans: [{ resource: { attributes: kv({ 'service.name': 'support-bot' }) }, scopeSpans: [{ scope: { name: 'x' }, spans }] }],
  });
  const chat = {
    'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'openai', 'gen_ai.request.model': 'gpt-5.5',
    'gen_ai.response.model': 'gpt-5.5-2026-08-01', 'gen_ai.request.max_tokens': 512, 'gen_ai.response.finish_reasons': ['length'],
    'gen_ai.usage.input_tokens': 1200, 'gen_ai.usage.cache_read.input_tokens': 1000, 'gen_ai.usage.cache_write.input_tokens': 50,
    'gen_ai.usage.output_tokens': 512, 'gen_ai.usage.reasoning.output_tokens': 100, 'gen_ai.conversation.id': 'conv-1',
    'gen_ai.system_instructions': '[{"type":"text","content":"You are a support agent."}]',
  };

  it('maps GenAI inference spans and moves cached tokens out of input', () => {
    const root = tmpTree({
      'traces.jsonl': jsonl(traces(
        span('A1', chat),
        span('A2', { ...chat, 'gen_ai.input.messages': '[{"role":"user","parts":[{"type":"text","content":"hi"}]}]' }),
        span('A3', { ...chat, 'gen_ai.operation.name': 'invoke_agent' }), // wraps the chat spans: not counted
        span('A4', { 'http.method': 'POST' }), // not a GenAI span
      )) + '{"partial":',
    });
    const events = parseAll(otel, root);
    assert.equal(events.length, 2);
    const [e] = events;
    assert.deepEqual(counts(e!), { input: 150, output: 512, reasoning: 100, cacheRead: 1000, cacheWrite: 50 });
    assert.equal(e!.model, 'gpt-5.5-2026-08-01');
    assert.equal(e!.vendor, 'openai');
    assert.equal(e!.ts, '2026-10-14T10:00:00.000Z');
    assert.equal(e!.sessionId, 'conv-1');
    assert.equal(e!.project, 'support-bot');
    assert.equal(e!.dedupeKey, 'otel:5b8efff798038103d269b633813fc60c:a1');
    assert.equal(e!.meta.stopReason, 'length');
    assert.equal(e!.meta.maxTokens, 512);
    assert.equal(e!.meta.latencyMs, 1500);
    assert.match(String(e!.meta.promptPrefixHash), /^[0-9a-f]{16}$/);
    assert.equal(e!.meta.promptPrefixHash, events[1]!.meta.promptPrefixHash, 'same system prompt, same prefix hash');
    assert.equal(e!.meta.requestHash, null, 'no input messages recorded, so no request hash');
    assert.match(String(events[1]!.meta.requestHash), /^[0-9a-f]{16}$/);
    assert.ok(!JSON.stringify(events).includes('support agent'), 'prompt text is never stored');
  });

  it('accepts the pre-rename token attributes and the old provider attribute', () => {
    const root = tmpTree({
      'old.json': jsonl(traces(span('B1', {
        'gen_ai.system': 'anthropic', 'gen_ai.request.model': 'claude-sonnet-5', 'gen_ai.usage.prompt_tokens': 40, 'gen_ai.usage.completion_tokens': 9,
      }))),
    });
    const [e] = parseAll(otel, root);
    assert.deepEqual(counts(e!), { input: 40, output: 9, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(e!.vendor, 'anthropic');
    assert.equal(e!.meta.operation, null);
  });

  it('reads Claude Code api_request events, whose input already excludes cache', () => {
    const record = (seq: number, extra: Record<string, Value> = {}) => ({
      timeUnixNano: String(start), body: { stringValue: 'claude_code.api_request' },
      attributes: kv({
        'event.name': 'api_request', 'event.timestamp': '2026-10-14T10:00:05.000Z', 'event.sequence': seq, 'session.id': 'sess-1',
        model: 'claude-opus-5-5', input_tokens: 12, output_tokens: 300, cache_read_tokens: 5000, cache_creation_tokens: 700,
        cache_creation_1h_tokens: 700, cache_creation_5m_tokens: 0, cost_usd: 0.0123, duration_ms: 4200, ttft_ms: 900, request_id: `req_${seq}`, query_source: 'repl_main_thread', ...extra,
      }),
    });
    const logs = {
      resourceLogs: [{
        resource: { attributes: kv({ 'service.name': 'claude-code' }) },
        scopeLogs: [{ logRecords: [record(1), record(1), record(2), { ...record(3), body: { stringValue: 'claude_code.user_prompt' }, attributes: kv({ 'event.name': 'user_prompt' }) }] }],
      }],
    };
    // a pretty-printed export, as `jq .` would leave it
    const root = tmpTree({ 'logs.json': JSON.stringify(logs, null, 2) });
    const events = parseAll(otel, root);
    assert.equal(events.length, 2, 'repeated records are deduplicated; other events are ignored');
    const [e] = events;
    assert.deepEqual(counts(e!), { input: 12, output: 300, reasoning: 0, cacheRead: 5000, cacheWrite: 700 });
    assert.equal(e!.ts, '2026-10-14T10:00:05.000Z');
    assert.equal(e!.recordedCostUsd, 0.0123);
    assert.equal(e!.dedupeKey, 'otel:claude-code:req_1');
    assert.equal(e!.sessionId, 'sess-1');
    assert.equal(e!.project, 'claude-code');
    assert.equal(e!.meta.latencyMs, 4200);
    assert.equal(e!.meta.ttftMs, 900);
    assert.equal(e!.meta.cacheWrite1h, 700);
  });

  it('takes a single file as a root', () => {
    const root = tmpTree({ 'export.ndjson': jsonl(traces(span('C1', chat))) });
    assert.equal(otel.discover(join(root, 'export.ndjson')).length, 1);
    assert.deepEqual(otel.discover(join(root, 'missing.json')), []);
  });
});
