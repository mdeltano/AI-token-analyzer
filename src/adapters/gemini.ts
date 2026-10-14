import { join } from 'node:path';
import type { UsageEvent } from '../schema/usage-event.ts';
import { hasUsage, makeEvent } from './event.ts';
import type { SourceAdapter } from './types.ts';
import { isObject, isoTime, readJson, readJsonl, str, tokens, walkFiles } from './util.ts';

/** Gemini CLI <= 0.38 writes one JSON document per session; later versions write JSONL. */
function loadSession(file: string): { header: Record<string, any>; messages: unknown[] } {
  const whole = readJson(file);
  if (isObject(whole) && Array.isArray(whole.messages)) return { header: whole, messages: whole.messages };

  const lines = readJsonl(file);
  const header = lines.find((l) => isObject(l) && 'sessionId' in l && !('type' in l));
  // JSONL may rewrite a message as it streams; keep the last version of each id
  const byId = new Map<string, unknown>();
  lines.forEach((l, i) => {
    if (isObject(l) && 'type' in l) byId.set(str(l.id) ?? `#${i}`, l);
  });
  return { header: isObject(header) ? header : {}, messages: [...byId.values()] };
}

/**
 * Gemini CLI sessions: `~/.gemini/tmp/<project>/chats/session-*.json[l]`. Each `gemini`
 * message carries `tokens: { input, output, cached, thoughts, tool, total }`, where `input`
 * includes `cached` and `output` excludes `thoughts`.
 */
export const gemini: SourceAdapter = {
  id: 'gemini-cli',
  displayName: 'Gemini CLI',

  defaultRoots({ home, env }) {
    return [join(env.GEMINI_CLI_HOME || home, '.gemini', 'tmp')];
  },

  discover(root) {
    return walkFiles(root, (p) => /[\\/]chats[\\/]session-[^\\/]*\.jsonl?$/.test(p));
  },

  parse(file) {
    const { header, messages } = loadSession(file);
    const sessionId = str(header.sessionId);
    const out: UsageEvent[] = [];

    messages.forEach((m, i) => {
      if (!isObject(m) || m.type !== 'gemini' || !isObject(m.tokens)) return;
      const model = str(m.model);
      const ts = isoTime(m.timestamp) ?? isoTime(header.startTime);
      if (!model || !ts) return;

      const t = m.tokens;
      const input = tokens(t.input);
      const cached = Math.min(tokens(t.cached), input);
      const thoughts = tokens(t.thoughts);

      const event = makeEvent({
        dedupeKey: `gemini-cli:${sessionId ?? file}:${str(m.id) ?? i}`,
        source: 'gemini-cli',
        providerId: 'google',
        model,
        ts,
        sessionId,
        project: str(header.projectHash),
        inputTokens: input - cached,
        cacheReadTokens: cached,
        outputTokens: tokens(t.output) + thoughts,
        reasoningTokens: thoughts,
        sourceFile: file,
        meta: { toolTokens: tokens(t.tool), toolCalls: Array.isArray(m.toolCalls) ? m.toolCalls.length : 0 },
      });
      if (hasUsage(event)) out.push(event);
    });
    return out;
  },
};
