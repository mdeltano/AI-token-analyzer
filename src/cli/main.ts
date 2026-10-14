#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { adapters, findAdapter, type AdapterEnv } from '../adapters/index.ts';
import { importAll } from '../importer.ts';
import { groupings, summarize, type Grouping } from '../report/summary.ts';
import { UsageStore } from '../store/db.ts';

const USAGE = `Usage: sundance <command> [options]

Commands:
  sources                 List supported tools and where their logs were found
  import                  Import usage from every detected tool's local logs
  summary                 Show token usage totals

Options:
  --db <path>             Database file (default: $SUNDANCE_DB or ~/.sundance/usage.db)
  --source <id>           Limit import/summary to one tool (see \`sundance sources\`)
  --path <dir>            import: read logs from this directory instead of the default (repeatable)
  --full                  import: re-read files that are unchanged since the last import
  --by <grouping>         summary: ${Object.keys(groupings).join(' | ')} (default: source)
  --since <YYYY-MM-DD>    summary: only usage on or after this date
`;

const fmt = new Intl.NumberFormat('en-US');
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      source: { type: 'string' },
      path: { type: 'string', multiple: true },
      full: { type: 'boolean', default: false },
      by: { type: 'string', default: 'source' },
      since: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return command || values.help ? 0 : 1;
  }

  const ctx: AdapterEnv = { home: homedir(), env: process.env };
  const selected = values.source ? findAdapter(values.source) : undefined;
  if (values.source && !selected) {
    process.stderr.write(`Unknown source "${values.source}". Known: ${adapters.map((a) => a.id).join(', ')}\n`);
    return 1;
  }

  if (command === 'sources') {
    const rows = adapters.map((a) => {
      const found = a.defaultRoots(ctx).filter((r) => existsSync(r));
      return [a.id, a.displayName, found.length ? found.join(', ') : '(not found)'];
    });
    console.log(table(['id', 'tool', 'log location'], rows));
    return 0;
  }

  const store = new UsageStore(values.db ?? process.env.SUNDANCE_DB ?? join(ctx.home, '.sundance', 'usage.db'));
  try {
    if (command === 'import') {
      const results = importAll(store, ctx, {
        adapters: selected ? [selected] : undefined,
        roots: values.path,
        full: values.full,
      });
      const rows = results
        .filter((r) => r.filesSeen > 0 || selected)
        .map((r) => [r.source, fmt.format(r.filesSeen), fmt.format(r.filesParsed), fmt.format(r.eventsParsed), fmt.format(r.eventsAdded)]);
      console.log(rows.length ? table(['source', 'files', 'parsed', 'events', 'new'], rows) : 'No logs found for any supported tool.');
      return 0;
    }

    if (command === 'summary') {
      if (!(values.by in groupings)) {
        process.stderr.write(`--by must be one of: ${Object.keys(groupings).join(', ')}\n`);
        return 1;
      }
      const rows = summarize(store, values.by as Grouping, { since: values.since, source: selected?.id });
      if (!rows.length) {
        console.log('No usage stored yet. Run `sundance import` first.');
        return 0;
      }
      const sum = (k: 'events' | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'total') => rows.reduce((n, r) => n + r[k], 0);
      const inputSide = sum('input') + sum('cacheRead') + sum('cacheWrite');
      const body = [...rows, {
        key: 'TOTAL', events: sum('events'), input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'),
        cacheWrite: sum('cacheWrite'), total: sum('total'), cacheHitRate: inputSide ? sum('cacheRead') / inputSide : 0,
      }].map((r) => [
        r.key, fmt.format(r.events), fmt.format(r.input), fmt.format(r.output), fmt.format(r.cacheRead),
        fmt.format(r.cacheWrite), fmt.format(r.total), pct(r.cacheHitRate),
      ]);
      console.log(table([values.by, 'calls', 'input', 'output', 'cache read', 'cache write', 'total', 'cache hit'], body));
      return 0;
    }
  } finally {
    store.close();
  }

  process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
