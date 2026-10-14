import { basename, dirname, join } from 'node:path';
import type { UsageEvent } from '../schema/usage-event.ts';
import { hasUsage, makeEvent } from './event.ts';
import type { SourceAdapter } from './types.ts';
import { isObject, isoTime, readJsonl, str, tokens, walkFiles } from './util.ts';

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

/**
 * GitHub Copilot CLI: `~/.copilot/session-state/<sessionId>/events.jsonl`. Per-message events
 * only carry output tokens, so usage is taken from `session.shutdown` rollups
 * (`modelMetrics[model].usage`). A resumed session writes another, cumulative, shutdown; each is
 * stored as the delta from the previous one. `inputTokens` includes the cache counts.
 */
export const copilotCli: SourceAdapter = {
  id: 'copilot-cli',
  displayName: 'GitHub Copilot CLI',

  defaultRoots({ home, env }) {
    return [join(env.COPILOT_HOME || join(home, '.copilot'), 'session-state')];
  },

  discover(root) {
    return walkFiles(root, (p) => basename(p) === 'events.jsonl');
  },

  parse(file) {
    const sessionId = basename(dirname(file));
    const out: UsageEvent[] = [];
    const prev = new Map<string, Totals>();
    const legs = new Map<string, number>();
    let project: string | null = null;
    let lastTs: string | null = null;

    for (const ev of readJsonl(file)) {
      if (!isObject(ev)) continue;
      const data = isObject(ev.data) ? ev.data : ev;
      lastTs = isoTime(ev.timestamp) ?? lastTs;
      if (ev.type === 'session.start') {
        project = str(data.context?.cwd) ?? str(data.cwd) ?? project;
        continue;
      }
      if (ev.type !== 'session.shutdown' || !isObject(data.modelMetrics)) continue;
      const ts = isoTime(ev.timestamp) ?? lastTs ?? isoTime(data.sessionStartTime);
      if (!ts) continue;

      for (const [model, metrics] of Object.entries(data.modelMetrics)) {
        const u = isObject(metrics) && isObject(metrics.usage) ? metrics.usage : null;
        if (!u) continue;
        const now: Totals = {
          input: tokens(u.inputTokens),
          output: tokens(u.outputTokens),
          cacheRead: tokens(u.cacheReadTokens),
          cacheWrite: tokens(u.cacheWriteTokens),
          reasoning: tokens(u.reasoningTokens),
        };
        const before = prev.get(model);
        // counters that went down mean the rollup was reset, so this leg is counted whole
        const base = before && now.input >= before.input ? before : null;
        prev.set(model, now);
        const d: Totals = base
          ? {
              input: now.input - base.input,
              output: Math.max(0, now.output - base.output),
              cacheRead: Math.max(0, now.cacheRead - base.cacheRead),
              cacheWrite: Math.max(0, now.cacheWrite - base.cacheWrite),
              reasoning: Math.max(0, now.reasoning - base.reasoning),
            }
          : now;
        const leg = legs.get(model) ?? 0;
        legs.set(model, leg + 1);

        const output = Math.max(d.output, d.reasoning);
        const event = makeEvent({
          dedupeKey: `copilot-cli:${sessionId}:shutdown:${model}:${leg}`,
          source: 'copilot-cli',
          model: model.replace(/^copilot\//, ''),
          ts,
          sessionId,
          project,
          inputTokens: Math.max(0, d.input - d.cacheRead - d.cacheWrite),
          outputTokens: output,
          reasoningTokens: d.reasoning,
          cacheReadTokens: d.cacheRead,
          cacheWriteTokens: d.cacheWrite,
          granularity: 'aggregate',
          sourceFile: file,
          meta: { premiumRequests: typeof metrics.requests?.count === 'number' ? metrics.requests.count : null },
        });
        if (hasUsage(event)) out.push(event);
      }
    }
    return out;
  },
};
