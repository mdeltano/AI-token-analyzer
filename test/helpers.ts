import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Create a temp directory containing `files` (relative path → contents). Returns its root. */
export function tmpTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sundance-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

export const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
