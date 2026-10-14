import type { UsageEvent } from '../schema/usage-event.ts';

export interface AdapterEnv {
  home: string;
  env: Record<string, string | undefined>;
}

/** Reads one tool's local logs and emits normalized usage events. */
export interface SourceAdapter {
  id: string;
  displayName: string;
  /** Directories where this tool keeps its logs on this machine (may not exist). */
  defaultRoots(ctx: AdapterEnv): string[];
  /** Log files under a root that this adapter can parse. */
  discover(root: string): string[];
  /** Parse one file. Must not throw on malformed content; skip what it can't read. */
  parse(file: string): UsageEvent[];
}
