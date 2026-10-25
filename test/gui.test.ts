import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createGuiServer } from '../src/gui/server.ts';
import { UsageStore } from '../src/store/db.ts';
import { tmpTree } from './helpers.ts';

const root = tmpTree({});
const dbPath = join(root, 'usage.db');
const store = new UsageStore(dbPath);
// an empty home, so no real tool logs or admin keys are picked up
const server = createGuiServer({ store, dbPath, ctx: { home: root, env: {} } });
let port = 0;

interface Reply {
  status: number;
  type: string;
  body: string;
}

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, method, path,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), body: text }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
});

describe('gui server', () => {
  it('serves the page and the source list', async () => {
    const page = await call('GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.body, /<title>Sundance<\/title>/);

    const sources = JSON.parse((await call('GET', '/api/sources')).body);
    assert.equal(sources.db, dbPath);
    assert.ok(sources.adapters.every((a: { found: string[] }) => a.found.length === 0));
    assert.ok(sources.connectors.every((c: { keySet: boolean }) => !c.keySet));
  });

  it('generates demo data that summary and analyze then report', async () => {
    const gen = await call('POST', '/api/generate', { seed: 7, days: 14 });
    assert.equal(gen.status, 200);
    const { events, added, planted } = JSON.parse(gen.body);
    assert.equal(added, events);
    assert.equal(planted.length, 5);

    const rows = JSON.parse((await call('GET', '/api/summary?by=project&source=synthetic')).body);
    assert.equal(rows.reduce((n: number, r: { events: number }) => n + r.events, 0), events);

    const analysis = JSON.parse((await call('GET', '/api/analyze?source=synthetic')).body);
    assert.equal(analysis.events, events);
    assert.deepEqual(
      analysis.findings.map((f: { kind: string }) => f.kind).sort(),
      planted.map((p: { kind: string }) => p.kind).sort(),
    );
    assert.ok(analysis.findings.every((f: { title: string }) => f.title));
  });

  it('reports bad input as a 400 with a message', async () => {
    for (const path of ['/api/summary?by=color', '/api/analyze?since=yesterday', '/api/analyze?source=nope']) {
      const res = await call('GET', path);
      assert.equal(res.status, 400, path);
      assert.ok(JSON.parse(res.body).error);
    }
    const suggest = await call('POST', '/api/suggest', { finding: 99 });
    assert.equal(suggest.status, 400);
    assert.match(JSON.parse(suggest.body).error, /finding must be between 1 and/);
  });

  it('skips fetch connectors whose key is not set', async () => {
    const results = JSON.parse((await call('POST', '/api/fetch', {})).body);
    assert.ok(results.length > 0 && results.every((r: { status: string }) => r.status === 'skipped'));
  });

  it('refuses requests from other hosts and non-JSON posts', async () => {
    assert.equal((await call('GET', '/api/sources', undefined, { host: 'evil.example' })).status, 403);
    const form = await call('POST', '/api/generate', undefined, { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(form.status, 415);
    assert.equal((await call('GET', '/api/nothing')).status, 404);
  });
});
