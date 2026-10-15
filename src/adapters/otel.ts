import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageEvent } from '../schema/usage-event.ts';
import { hasUsage, makeEvent } from './event.ts';
import type { SourceAdapter } from './types.ts';
import { isObject, isoTime, readJson, readJsonl, str, tokens, walkFiles } from './util.ts';

type Attrs = Record<string, unknown>;

/** Operations that are one model call. Agent and tool spans wrap those calls, so counting them would double-count. */
const INFERENCE_OPS = new Set(['chat', 'text_completion', 'generate_content', 'embeddings']);
const CLAUDE_CODE_REQUEST = 'claude_code.api_request';

/**
 * OpenTelemetry exports in the OTLP JSON encoding, as written by the Collector's file exporter:
 * one `ExportTraceServiceRequest` / `ExportLogsServiceRequest` per line (a single pretty-printed
 * object also works). Two kinds of record become events:
 *
 * - GenAI inference spans (semantic conventions in open-telemetry/semantic-conventions-genai).
 *   Their `gen_ai.usage.input_tokens` includes cache reads and writes, so those are subtracted.
 * - Claude Code `claude_code.api_request` log events, whose `input_tokens` already excludes cache.
 *
 * Prompt content, when an instrumentation records it, is hashed into `promptPrefixHash` and
 * `requestHash` and never stored.
 */
export const otel: SourceAdapter = {
  id: 'otel',
  displayName: 'OpenTelemetry export (OTLP JSON)',

  defaultRoots({ home, env }) {
    return [env.SUNDANCE_OTEL_DIR || join(home, '.sundance', 'otel')];
  },

  discover(root) {
    try {
      if (statSync(root).isFile()) return [root];
    } catch {
      return [];
    }
    return walkFiles(root, (p) => /\.(?:jsonl?|ndjson)$/i.test(p));
  },

  parse(file) {
    let docs = readJsonl(file);
    // a pretty-printed export spans many lines, none of which parses alone
    if (!docs.length) docs = [readJson(file)];

    const out: UsageEvent[] = [];
    const seen = new Set<string>();
    const add = (e: UsageEvent | null) => {
      if (e && hasUsage(e) && !seen.has(e.dedupeKey)) {
        seen.add(e.dedupeKey);
        out.push(e);
      }
    };
    for (const doc of docs) {
      if (!isObject(doc)) continue;
      for (const rs of list(doc.resourceSpans)) {
        const resource = attrs(rs.resource?.attributes);
        for (const ss of list(rs.scopeSpans)) for (const span of list(ss.spans)) add(fromSpan(span, resource, file));
      }
      for (const rl of list(doc.resourceLogs)) {
        const resource = attrs(rl.resource?.attributes);
        for (const sl of list(rl.scopeLogs)) for (const rec of list(sl.logRecords)) add(fromClaudeCodeLog(rec, resource, file));
      }
    }
    return out;
  },
};

function fromSpan(span: Record<string, any>, resource: Attrs, file: string): UsageEvent | null {
  const a = attrs(span.attributes);
  const op = str(a['gen_ai.operation.name']);
  if (op ? !INFERENCE_OPS.has(op) : !('gen_ai.usage.input_tokens' in a || 'gen_ai.usage.prompt_tokens' in a)) return null;

  const model = str(a['gen_ai.response.model']) ?? str(a['gen_ai.request.model']);
  const ts = isoTime(nanos(span.startTimeUnixNano));
  const traceId = str(span.traceId);
  const spanId = str(span.spanId);
  if (!model || !ts || !traceId || !spanId) return null;

  // `prompt_tokens` / `completion_tokens` are the names used before the conventions renamed them
  const input = tokens(num(a['gen_ai.usage.input_tokens'] ?? a['gen_ai.usage.prompt_tokens']));
  const cacheRead = tokens(num(a['gen_ai.usage.cache_read.input_tokens']));
  const cacheWrite = tokens(num(a['gen_ai.usage.cache_write.input_tokens']));
  const start = nanos(span.startTimeUnixNano);
  const end = nanos(span.endTimeUnixNano);
  const finish = a['gen_ai.response.finish_reasons'];
  const system = a['gen_ai.system_instructions'];
  const tools = a['gen_ai.tool.definitions'];
  const messages = a['gen_ai.input.messages'];

  return makeEvent({
    dedupeKey: `otel:${traceId.toLowerCase()}:${spanId.toLowerCase()}`,
    source: 'otel',
    model,
    ts,
    providerId: str(a['gen_ai.provider.name']) ?? str(a['gen_ai.system']),
    sessionId: str(a['gen_ai.conversation.id']) ?? str(a['session.id']) ?? str(resource['session.id']),
    project: str(a['sundance.feature']) ?? str(resource['service.name']),
    inputTokens: Math.max(0, input - cacheRead - cacheWrite),
    outputTokens: tokens(num(a['gen_ai.usage.output_tokens'] ?? a['gen_ai.usage.completion_tokens'])),
    reasoningTokens: tokens(num(a['gen_ai.usage.reasoning.output_tokens'])),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    sourceFile: file,
    meta: {
      operation: op,
      stopReason: Array.isArray(finish) ? str(finish[0]) : str(finish),
      maxTokens: num(a['gen_ai.request.max_tokens']) ?? null,
      latencyMs: start !== undefined && end !== undefined && end >= start ? Math.round((end - start) / 1e6) : null,
      responseId: str(a['gen_ai.response.id']),
      trigger: str(a['sundance.trigger']),
      service: str(resource['service.name']),
      promptPrefixHash: system === undefined && tools === undefined ? null : hash([system ?? null, tools ?? null]),
      requestHash: messages === undefined ? null : hash([model, system ?? null, tools ?? null, messages]),
      traceId,
    },
  });
}

function fromClaudeCodeLog(rec: Record<string, any>, resource: Attrs, file: string): UsageEvent | null {
  const a = attrs(rec.attributes);
  const body = isObject(rec.body) ? anyValue(rec.body) : undefined;
  const named = rec.eventName === CLAUDE_CODE_REQUEST || body === CLAUDE_CODE_REQUEST;
  if (!named && !(a['event.name'] === 'api_request' && 'input_tokens' in a)) return null;

  const model = str(a.model);
  const ts = isoTime(a['event.timestamp']) ?? isoTime(nanos(rec.timeUnixNano)) ?? isoTime(nanos(rec.observedTimeUnixNano));
  const sessionId = str(a['session.id']) ?? str(resource['session.id']);
  const id = str(a.request_id) ?? str(a.client_request_id) ?? (sessionId && num(a['event.sequence']) !== undefined ? `${sessionId}:${num(a['event.sequence'])}` : null);
  if (!model || !ts || !id) return null;

  const cost = num(a.cost_usd);
  return makeEvent({
    dedupeKey: `otel:claude-code:${id}`,
    source: 'otel',
    model,
    ts,
    providerId: 'anthropic',
    sessionId,
    project: str(resource['service.name']) ?? 'claude-code',
    inputTokens: tokens(num(a.input_tokens)),
    outputTokens: tokens(num(a.output_tokens)),
    cacheReadTokens: tokens(num(a.cache_read_tokens)),
    cacheWriteTokens: tokens(num(a.cache_creation_tokens)),
    recordedCostUsd: cost !== undefined && cost >= 0 ? cost : null,
    sourceFile: file,
    meta: {
      latencyMs: num(a.duration_ms) ?? null,
      ttftMs: num(a.ttft_ms) ?? null,
      // the 1-hour TTL is priced higher than the default 5 minutes
      cacheWrite1h: tokens(num(a.cache_creation_1h_tokens)),
      cacheWrite5m: tokens(num(a.cache_creation_5m_tokens)),
      querySource: str(a.query_source),
      speed: str(a.speed),
      effort: str(a.effort),
      promptId: str(a['prompt.id']),
      service: str(resource['service.name']),
    },
  });
}

const list = (v: unknown): Record<string, any>[] => (Array.isArray(v) ? v.filter(isObject) : []);

/** Flatten an OTLP `KeyValue[]` into plain values. */
function attrs(kvs: unknown): Attrs {
  const out: Attrs = {};
  for (const kv of list(kvs)) {
    if (typeof kv.key === 'string' && isObject(kv.value)) out[kv.key] = anyValue(kv.value);
  }
  return out;
}

function anyValue(v: Record<string, any>): unknown {
  if ('stringValue' in v) return v.stringValue;
  if ('boolValue' in v) return v.boolValue;
  // 64-bit ints are encoded as decimal strings in OTLP JSON
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('arrayValue' in v) return list(v.arrayValue?.values).map(anyValue);
  if ('kvlistValue' in v) return attrs(v.kvlistValue?.values);
  if ('bytesValue' in v) return v.bytesValue;
  return undefined;
}

/** A number, or a numeric string as some exporters send counts. */
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Epoch nanoseconds; `isoTime` recognizes the magnitude. "0" means unset in OTLP. */
function nanos(v: unknown): number | undefined {
  const n = num(v);
  return n ? n : undefined;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}
