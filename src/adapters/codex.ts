import { join } from 'node:path';
import type { UsageEvent } from '../schema/usage-event.ts';
import { hasUsage, makeEvent } from './event.ts';
import type { SourceAdapter } from './types.ts';
import { isObject, isoTime, readJsonl, str, tokens, walkFiles } from './util.ts';

interface CodexUsage {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
}

function readUsage(u: unknown): CodexUsage | null {
  if (!isObject(u)) return null;
  const input = tokens(u.input_tokens);
  const cached = tokens(u.cached_input_tokens ?? u.cache_read_input_tokens);
  const output = tokens(u.output_tokens);
  const reasoning = tokens(u.reasoning_output_tokens);
  const total = tokens(u.total_tokens) || input + output;
  return { input, cached, output, reasoning, total };
}

function minus(a: CodexUsage, b: CodexUsage | null): CodexUsage {
  if (!b) return a;
  return {
    input: Math.max(0, a.input - b.input),
    cached: Math.max(0, a.cached - b.cached),
    output: Math.max(0, a.output - b.output),
    reasoning: Math.max(0, a.reasoning - b.reasoning),
    total: Math.max(0, a.total - b.total),
  };
}

/**
 * OpenAI Codex CLI rollouts: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` and
 * `archived_sessions/`. Usage arrives as `event_msg` / `token_count` events carrying both the
 * cumulative `total_token_usage` and the per-turn `last_token_usage`. OpenAI counts cached
 * tokens inside `input_tokens` and reasoning inside `output_tokens`.
 */
export const codex: SourceAdapter = {
  id: 'codex',
  displayName: 'OpenAI Codex CLI',

  defaultRoots({ home, env }) {
    const base = env.CODEX_HOME || join(home, '.codex');
    return [join(base, 'sessions'), join(base, 'archived_sessions')];
  },

  discover(root) {
    return walkFiles(root, (p) => /rollout-[^\\/]*\.jsonl$/.test(p));
  },

  parse(file) {
    const out: UsageEvent[] = [];
    let sessionId: string | null = null;
    let project: string | null = null;
    let model: string | null = null;
    let prevTotal: CodexUsage | null = null;

    readJsonl(file).forEach((line, index) => {
      if (!isObject(line) || !isObject(line.payload)) return;
      const p = line.payload;

      if (line.type === 'session_meta') {
        sessionId = str(p.id) ?? sessionId;
        project = str(p.cwd) ?? project;
        model = str(p.model) ?? model;
        return;
      }
      if (line.type === 'turn_context') {
        model = str(p.model) ?? model;
        project = str(p.cwd) ?? project;
        return;
      }
      if (line.type !== 'event_msg' || p.type !== 'token_count' || !isObject(p.info)) return;

      const total = readUsage(p.info.total_token_usage);
      // a repeated snapshot with an unchanged cumulative total is a re-emission, not a new call
      if (total && prevTotal && total.total === prevTotal.total) return;
      const turn = readUsage(p.info.last_token_usage) ?? (total ? minus(total, prevTotal) : null);
      if (total) prevTotal = total;
      if (!turn) return;

      const ts = isoTime(line.timestamp);
      if (!ts) return;
      const resolvedModel = str(p.info.model) ?? model ?? 'gpt-5';
      const key = total
        ? `codex:${sessionId ?? file}:${total.total}`
        : `codex:${sessionId ?? file}:line${index}`;

      const event = makeEvent({
        dedupeKey: key,
        source: 'codex',
        providerId: 'openai',
        model: resolvedModel,
        ts,
        sessionId,
        project,
        inputTokens: Math.max(0, turn.input - turn.cached),
        cacheReadTokens: turn.cached,
        outputTokens: turn.output,
        reasoningTokens: Math.min(turn.reasoning, turn.output),
        sourceFile: file,
        meta: { contextWindow: tokens(p.info.model_context_window) || null },
      });
      if (hasUsage(event)) out.push(event);
    });
    return out;
  },
};
