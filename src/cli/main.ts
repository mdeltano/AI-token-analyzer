#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { adapters, findAdapter, type AdapterEnv } from '../adapters/index.ts';
import { analyze, analyzers } from '../analyze/index.ts';
import { connectors, fetchAll, findConnector } from '../connectors/index.ts';
import { importAll } from '../importer.ts';
import { groupings, summarize, type Grouping } from '../report/summary.ts';
import { UsageStore } from '../store/db.ts';
import { generateWorkload, SYNTHETIC_SOURCE } from '../synth/workload.ts';

const USAGE = `Usage: sundance <command> [options]

Commands:
  sources                 List supported tools and provider APIs, and what was found
  import                  Import usage from every detected tool's local logs
  fetch                   Fetch daily usage from provider usage APIs (needs admin keys)
  summary                 Show token usage totals
  analyze                 Find wasted tokens and estimate what fixing each case saves
  generate                Add a synthetic company workload with known, planted waste

Options:
  --db <path>             Database file (default: $SUNDANCE_DB or ~/.sundance/usage.db)
  --source <id>           Limit import/fetch/summary/analyze to one source (see \`sundance sources\`);
                          summary and analyze also accept "${SYNTHETIC_SOURCE}"
  --path <dir>            import: read logs from this directory instead of the default (repeatable)
  --full                  import: re-read files that are unchanged since the last import
  --by <grouping>         summary: ${Object.keys(groupings).join(' | ')} (default: source)
  --since <YYYY-MM-DD>    summary/analyze: only usage on or after this date;
                          fetch: first day to fetch (default: 30 days ago)
  --seed <n>              generate: random seed (default: 42)
  --days <n>              generate: days of traffic (default: 30)
  --end <YYYY-MM-DD>      generate: last day covered (default: yesterday)
  --scale <x>             generate: call volume multiplier (default: 1)
  --manifest <file>       generate: also write the planted-waste manifest as JSON
`;

const fmt = new Intl.NumberFormat('en-US');
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  // numbers right-aligned, text left-aligned; the first column is always a label
  const numeric = headers.map((_, i) => i > 0 && rows.every((r) => /^(?:[$\d.,%-]+|n\/a)$/.test(r[i]!)));
  const line = (cells: string[]) => cells.map((c, i) => (numeric[i] ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

async function main(argv: string[]): Promise<number> {
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
      seed: { type: 'string' },
      days: { type: 'string' },
      end: { type: 'string' },
      scale: { type: 'string' },
      manifest: { type: 'string' },
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
  const connector = values.source ? findConnector(values.source) : undefined;
  const known = command === 'import' ? adapters.map((a) => a.id)
    : command === 'fetch' ? connectors.map((c) => c.id)
    : [...adapters.map((a) => a.id), ...connectors.map((c) => c.id), SYNTHETIC_SOURCE];
  if (values.source && !known.includes(values.source)) {
    process.stderr.write(`Unknown source "${values.source}" for ${command}. Known: ${known.join(', ')}\n`);
    return 1;
  }

  if (command === 'sources') {
    const rows = adapters.map((a) => {
      const found = a.defaultRoots(ctx).filter((r) => existsSync(r));
      return [a.id, a.displayName, found.length ? found.join(', ') : '(not found)'];
    });
    for (const c of connectors) rows.push([c.id, c.displayName, `${c.keyEnv} ${ctx.env[c.keyEnv] ? 'is set' : 'not set'}`]);
    console.log(table(['id', 'source', 'found'], rows));
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

    if (command === 'fetch') {
      const today = new Date(new Date().toISOString().slice(0, 10));
      const since = values.since ? new Date(values.since) : new Date(today.getTime() - 30 * 86_400_000);
      if ((values.since && !/^\d{4}-\d{2}-\d{2}$/.test(values.since)) || Number.isNaN(since.getTime()) || since >= today) {
        process.stderr.write('--since must be a date (YYYY-MM-DD) before today.\n');
        return 1;
      }
      const results = await fetchAll(store, ctx.env, { connectors: connector ? [connector] : undefined, since, until: today });
      const last = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);
      console.log(`Daily usage from ${since.toISOString().slice(0, 10)} through ${last} (UTC):\n`);
      console.log(table(['source', 'status', 'daily rows', 'tokens'], results.map((r) => [
        r.source, r.status === 'ok' ? 'ok' : `${r.status}: ${r.detail}`, fmt.format(r.events), fmt.format(r.tokens),
      ])));
      return results.some((r) => r.status === 'failed') ? 1 : 0;
    }

    if (command === 'summary') {
      if (!(values.by in groupings)) {
        process.stderr.write(`--by must be one of: ${Object.keys(groupings).join(', ')}\n`);
        return 1;
      }
      const rows = summarize(store, values.by as Grouping, { since: values.since, source: values.source });
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

    if (command === 'analyze') {
      const result = analyze(store.events({ since: values.since, source: values.source }));
      if (!result.events) {
        console.log('No usage stored yet. Run `sundance import` first.');
        return 0;
      }
      const saved = result.findings.reduce((n, f) => n + (f.savingsUsd ?? 0), 0);
      console.log(`Analyzed ${fmt.format(result.events)} calls, estimated spend ${usd.format(result.spendUsd)} at list price.`);
      if (result.unpricedModels.length) console.log(`No price for: ${result.unpricedModels.join(', ')} (excluded from dollar figures).`);
      if (!result.findings.length) {
        console.log('\nNo waste found.');
        return 0;
      }
      console.log(`${result.findings.length} findings, estimated savings ${usd.format(saved)}` +
        `${result.spendUsd ? ` (${pct(saved / result.spendUsd)} of spend)` : ''}. Findings can overlap, so savings may not fully add up.\n`);
      console.log(table(
        ['#', 'waste', 'project', 'model', 'calls', 'tokens', 'est. savings'],
        result.findings.map((f, i) => [
          String(i + 1), f.kind, f.project ?? '(none)', f.model, fmt.format(f.events), fmt.format(f.tokens),
          f.savingsUsd === null ? 'n/a' : usd.format(f.savingsUsd),
        ]),
      ));
      result.findings.forEach((f, i) => {
        const title = analyzers.find((a) => a.kind === f.kind)!.title;
        console.log(`\n${i + 1}. ${title}: ${f.project ?? '(no project)'} on ${f.model}\n   ${f.evidence}\n   Fix: ${f.recommendation}`);
      });
      return 0;
    }

    if (command === 'generate') {
      const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
      const workload = generateWorkload({ seed: num(values.seed), days: num(values.days), end: values.end, scale: num(values.scale) });
      const added = store.insert(workload.events);
      if (values.manifest) writeFileSync(values.manifest, JSON.stringify({ ...workload.options, planted: workload.planted }, null, 2) + '\n');
      const { seed, days, end } = workload.options;
      console.log(`Generated ${fmt.format(workload.events.length)} calls (${fmt.format(added)} new) for ${days} days ending ${end}, seed ${seed}.\n`);
      console.log(table(
        ['planted waste', 'project', 'model', 'calls', 'tokens'],
        workload.planted.map((p) => [p.kind, p.project, p.model, fmt.format(p.events), fmt.format(p.tokens)]),
      ));
      return 0;
    }
  } finally {
    store.close();
  }

  process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
  return 1;
}

process.exitCode = await main(process.argv.slice(2));
