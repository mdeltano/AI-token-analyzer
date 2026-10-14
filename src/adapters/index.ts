import { amp } from './amp.ts';
import { claudeCode } from './claude-code.ts';
import { codex } from './codex.ts';
import { copilotCli } from './copilot-cli.ts';
import { gemini } from './gemini.ts';
import { opencode } from './opencode.ts';
import { qwen } from './qwen.ts';
import type { SourceAdapter } from './types.ts';

export const adapters: readonly SourceAdapter[] = [claudeCode, codex, gemini, qwen, opencode, amp, copilotCli];

export function findAdapter(id: string): SourceAdapter | undefined {
  return adapters.find((a) => a.id === id);
}

export type { SourceAdapter, AdapterEnv } from './types.ts';
