import { join } from 'node:path';
import type { UsageEvent } from '../schema/usage-event.ts';
import { hasUsage, makeEvent } from './event.ts';
import type { SourceAdapter } from './types.ts';
import { isObject, isoTime, readJson, str, tokens, walkFiles } from './util.ts';

/**
 * Amp threads: `$AMP_DATA_DIR/threads/**.json` (default `~/.local/share/amp`). Usage comes from
 * `usageLedger.events` when present (cache counts are joined in from the linked assistant
 * message), otherwise from each assistant message's `usage` block.
 */
export const amp: SourceAdapter = {
  id: 'amp',
  displayName: 'Amp',

  defaultRoots({ home, env }) {
    const dirs = env.AMP_DATA_DIR?.split(',').map((p) => p.trim()).filter(Boolean);
    return (dirs?.length ? dirs : [join(home, '.local', 'share', 'amp')]).map((d) => join(d, 'threads'));
  },

  discover(root) {
    return walkFiles(root, (p) => p.endsWith('.json'));
  },

  parse(file) {
    const thread = readJson(file);
    if (!isObject(thread)) return [];
    const threadId = str(thread.id);
    if (!threadId) return [];
    const messages: unknown[] = Array.isArray(thread.messages) ? thread.messages : [];
    const out: UsageEvent[] = [];

    const byMessageId = new Map<unknown, Record<string, any>>();
    for (const m of messages) if (isObject(m) && m.messageId !== undefined) byMessageId.set(m.messageId, m);

    const ledger: unknown[] = isObject(thread.usageLedger) && Array.isArray(thread.usageLedger.events) ? thread.usageLedger.events : [];
    for (const ev of ledger) {
      if (!isObject(ev)) continue;
      const model = str(ev.model);
      const ts = isoTime(ev.timestamp);
      if (!model || !ts) continue;
      const linked = byMessageId.get(ev.toMessageId)?.usage;
      const input = tokens(ev.tokens?.input);
      const output = tokens(ev.tokens?.output);
      const cacheRead = tokens(linked?.cacheReadInputTokens);
      const cacheWrite = tokens(linked?.cacheCreationInputTokens);
      // the ledger's total can include tokens not broken out elsewhere; attribute them to output
      const remainder = Math.max(0, tokens(ev.tokens?.total) - input - output - cacheRead - cacheWrite);

      const event = makeEvent({
        dedupeKey: str(ev.id) ? `amp:${threadId}:${ev.id}` : `amp:${threadId}:${ts}:${model}:${input}x${output}`,
        source: 'amp',
        model,
        ts,
        sessionId: threadId,
        inputTokens: input,
        outputTokens: output + remainder,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        sourceFile: file,
        meta: { credits: typeof ev.credits === 'number' ? ev.credits : null },
      });
      if (hasUsage(event)) out.push(event);
    }
    if (out.length) return out;

    messages.forEach((m, i) => {
      if (!isObject(m) || m.role !== 'assistant' || !isObject(m.usage)) return;
      const u = m.usage;
      const model = str(u.model) ?? str(m.model);
      const ts = isoTime(u.timestamp) ?? isoTime(m.timestamp);
      if (!model || !ts) return;
      const input = tokens(u.inputTokens);
      const output = tokens(u.outputTokens);
      const cacheRead = tokens(u.cacheReadInputTokens);
      const cacheWrite = tokens(u.cacheCreationInputTokens);
      const noBreakdown = input + output + cacheRead + cacheWrite === 0;

      const event = makeEvent({
        dedupeKey: `amp:${threadId}:msg${m.messageId ?? i}`,
        source: 'amp',
        model,
        ts,
        sessionId: threadId,
        inputTokens: input,
        outputTokens: noBreakdown ? tokens(u.totalTokens) : output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        sourceFile: file,
      });
      if (hasUsage(event)) out.push(event);
    });
    return out;
  },
};
