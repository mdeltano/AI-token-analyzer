import { basename, join, sep } from 'node:path';
import type { UsageEvent } from '../schema/usage-event.ts';
import { hasUsage, makeEvent } from './event.ts';
import type { SourceAdapter } from './types.ts';
import { isObject, isoTime, readJsonl, str, tokens, walkFiles } from './util.ts';

/**
 * Claude Code transcripts: `<config>/projects/<project>/<session>.jsonl`, plus
 * `<session>/subagents/agent-*.jsonl`. One API response is written as several lines (one per
 * content block) that repeat the same `message.id` and usage, so events are keyed by message id.
 */
export const claudeCode: SourceAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',

  defaultRoots({ home, env }) {
    const configured = env.CLAUDE_CONFIG_DIR?.split(',').map((p) => p.trim()).filter(Boolean);
    const dirs = configured?.length ? configured : [join(home, '.claude'), join(home, '.config', 'claude')];
    return dirs.map((d) => join(d, 'projects'));
  },

  discover(root) {
    return walkFiles(root, (p) => p.endsWith('.jsonl'));
  },

  parse(file) {
    const out: UsageEvent[] = [];
    const seen = new Set<string>();
    const subagent = file.includes(`${sep}subagents${sep}`) || basename(file).startsWith('agent-');

    for (const line of readJsonl(file)) {
      if (!isObject(line) || line.type !== 'assistant' || !isObject(line.message)) continue;
      const msg = line.message;
      const usage = msg.usage;
      const model = str(msg.model);
      // '<synthetic>' marks locally generated messages (errors, interrupts) that cost nothing
      if (!isObject(usage) || !model || model === '<synthetic>') continue;

      const id = str(msg.id) ?? str(line.uuid);
      const key = `claude-code:${id}:${str(line.requestId) ?? ''}`;
      if (!id || seen.has(key)) continue;
      seen.add(key);

      const ts = isoTime(line.timestamp);
      if (!ts) continue;

      const event = makeEvent({
        dedupeKey: key,
        source: 'claude-code',
        model,
        ts,
        sessionId: str(line.sessionId),
        project: str(line.cwd),
        inputTokens: tokens(usage.input_tokens),
        outputTokens: tokens(usage.output_tokens),
        reasoningTokens: tokens(usage.output_tokens_details?.thinking_tokens),
        cacheReadTokens: tokens(usage.cache_read_input_tokens),
        cacheWriteTokens: tokens(usage.cache_creation_input_tokens),
        sourceFile: file,
        meta: {
          stopReason: str(msg.stop_reason),
          serviceTier: str(usage.service_tier),
          cacheWrite1h: tokens(usage.cache_creation?.ephemeral_1h_input_tokens),
          cacheWrite5m: tokens(usage.cache_creation?.ephemeral_5m_input_tokens),
          webSearches: tokens(usage.server_tool_use?.web_search_requests),
          subagent: subagent || line.isSidechain === true,
          gitBranch: str(line.gitBranch),
          entrypoint: str(line.entrypoint),
          version: str(line.version),
        },
      });
      if (hasUsage(event)) out.push(event);
    }
    return out;
  },
};
