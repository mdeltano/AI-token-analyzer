import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Recursively list files under `root` whose path matches `match`. Missing roots yield nothing. */
export function walkFiles(root: string, match: (path: string) => boolean): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, match));
    else if (entry.isFile() && match(full)) out.push(full);
  }
  return out.sort();
}

export function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Parse JSONL, skipping blank and malformed lines. */
export function readJsonl(file: string): unknown[] {
  const text = readText(file);
  if (text === null) return [];
  const out: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partial trailing line from a live session, or corruption: skip
    }
  }
  return out;
}

export function readJson(file: string): unknown {
  const text = readText(file);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Coerce to a non-negative safe integer; anything else becomes 0. */
export function tokens(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0;
  return Math.min(Math.round(v), Number.MAX_SAFE_INTEGER);
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Normalize a timestamp (ISO string, or epoch s/ms/ns) to ISO, or null if unusable. */
export function isoTime(v: unknown): string | null {
  let d: Date;
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v > 1e15 ? v / 1e6 : v > 1e12 ? v : v * 1000;
    d = new Date(ms);
  } else if (typeof v === 'string' && v) {
    d = new Date(v);
  } else {
    return null;
  }
  const t = d.getTime();
  // reject invalid dates and obviously bogus ones (before 2001)
  if (!Number.isFinite(t) || t < 978307200000) return null;
  return d.toISOString();
}

export function fileMtimeIso(file: string): string {
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/** Best-effort model vendor from a model id or an explicit provider id. */
export function inferVendor(model: string, providerId?: string | null): string {
  const p = providerId?.toLowerCase();
  if (p) {
    if (p.includes('anthropic') || p.includes('claude')) return 'anthropic';
    if (p.includes('openai') || p.includes('azure')) return 'openai';
    if (p.includes('google') || p.includes('gemini') || p.includes('vertex')) return 'google';
  }
  const m = model.toLowerCase();
  if (m.includes('claude')) return 'anthropic';
  if (/(^|[/-])(gpt|o\d|codex|chatgpt)/.test(m)) return 'openai';
  if (m.includes('gemini') || m.includes('gemma')) return 'google';
  if (m.includes('qwen')) return 'alibaba';
  if (m.includes('grok')) return 'xai';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('mistral') || m.includes('codestral') || m.includes('devstral')) return 'mistral';
  if (m.includes('kimi')) return 'moonshot';
  return p ?? 'unknown';
}
