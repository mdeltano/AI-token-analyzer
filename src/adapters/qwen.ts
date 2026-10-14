import { basename, dirname, join } from 'node:path';
import type { UsageEvent } from '../schema/usage-event.ts';
import { hasUsage, makeEvent } from './event.ts';
import type { SourceAdapter } from './types.ts';
import { fileMtimeIso, isObject, isoTime, readJsonl, str, tokens, walkFiles } from './util.ts';

/**
 * Qwen Code sessions: `~/.qwen/projects/<project>/chats/*.jsonl`. Assistant records carry
 * Gemini-API `usageMetadata`, where `promptTokenCount` includes `cachedContentTokenCount` and
 * `candidatesTokenCount` excludes `thoughtsTokenCount`.
 */
export const qwen: SourceAdapter = {
  id: 'qwen-code',
  displayName: 'Qwen Code',

  defaultRoots({ home, env }) {
    return [env.QWEN_DATA_DIR || join(home, '.qwen', 'projects')];
  },

  discover(root) {
    return walkFiles(root, (p) => /[\\/]chats[\\/][^\\/]+\.jsonl$/.test(p));
  },

  parse(file) {
    const out: UsageEvent[] = [];
    const seen = new Set<string>();
    const project = basename(dirname(dirname(file)));

    readJsonl(file).forEach((r, i) => {
      if (!isObject(r) || r.type !== 'assistant' || !isObject(r.usageMetadata)) return;
      const u = r.usageMetadata;
      const sessionId = str(r.sessionId);
      const key = `qwen-code:${sessionId ?? file}:${str(r.uuid) ?? i}`;
      if (seen.has(key)) return;
      seen.add(key);

      const prompt = tokens(u.promptTokenCount);
      const cached = Math.min(tokens(u.cachedContentTokenCount), prompt);
      const thoughts = tokens(u.thoughtsTokenCount);

      const event = makeEvent({
        dedupeKey: key,
        source: 'qwen-code',
        model: str(r.model) ?? 'qwen-auto',
        ts: isoTime(r.timestamp) ?? fileMtimeIso(file),
        sessionId,
        project: str(r.cwd) ?? project,
        inputTokens: prompt - cached,
        cacheReadTokens: cached,
        outputTokens: tokens(u.candidatesTokenCount) + thoughts,
        reasoningTokens: thoughts,
        sourceFile: file,
      });
      if (hasUsage(event)) out.push(event);
    });
    return out;
  },
};
