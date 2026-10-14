import { statSync } from 'node:fs';
import { adapters as allAdapters, type AdapterEnv, type SourceAdapter } from './adapters/index.ts';
import type { UsageStore } from './store/db.ts';

export interface ImportOptions {
  adapters?: readonly SourceAdapter[];
  /** Explicit roots replace each adapter's default locations. */
  roots?: string[];
  /** Re-parse files even if their size and mtime are unchanged. */
  full?: boolean;
}

export interface SourceResult {
  source: string;
  roots: string[];
  filesSeen: number;
  filesParsed: number;
  eventsParsed: number;
  eventsAdded: number;
}

export function importAll(store: UsageStore, ctx: AdapterEnv, opts: ImportOptions = {}): SourceResult[] {
  return (opts.adapters ?? allAdapters).map((adapter) => {
    const roots = opts.roots ?? adapter.defaultRoots(ctx);
    const result: SourceResult = { source: adapter.id, roots, filesSeen: 0, filesParsed: 0, eventsParsed: 0, eventsAdded: 0 };

    for (const root of roots) {
      for (const file of adapter.discover(root)) {
        result.filesSeen++;
        let stamp;
        try {
          const s = statSync(file);
          stamp = { size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          continue;
        }
        const prev = store.fileStamp(file);
        if (!opts.full && prev && prev.size === stamp.size && prev.mtimeMs === Math.trunc(stamp.mtimeMs)) continue;

        const events = adapter.parse(file);
        result.filesParsed++;
        result.eventsParsed += events.length;
        result.eventsAdded += store.insert(events);
        store.recordFile(file, adapter.id, stamp);
      }
    }
    return result;
  });
}
