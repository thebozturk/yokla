import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inventory, MAX_FILE_BYTES } from './inventory.ts';
import { MAX_ROWS, rowsOf } from './data.ts';

function repository(files: Readonly<Record<string, string | Buffer>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-inventory-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const listed = (dir: string, max = 100) =>
  Object.fromEntries(inventory(dir, max).files.map((file) => [file.path, file.kind]));

describe('inventory (ADR-0047)', () => {
  it('sorts each file into its kind', () => {
    const dir = repository({
      'README.md': '# Shop',
      'docs/guide.txt': 'How it works',
      'notes.rst': 'Notes',
      'prompts/system.txt': 'You are a shop assistant.',
      'src/writer-prompt.ts': 'export const prompt = "";',
      'src/app.ts': 'export {};',
      'app.py': 'print(1)',
      'data/catalog.jsonl': '{"id":"A","price":1}\n',
      'data/items.json': '[{"id":"A"}]',
      'data/prices.csv': 'id,price\nA,1\n',
      'data/settings.json': '{"theme":"dark"}',
      'openapi.yaml': 'openapi: 3.1.0\n',
      'schemas/reply.json': '{"$schema":"https://json-schema.org/draft/2020-12/schema"}',
      '.env.example': 'OPENAI_BASE_URL=',
      'deploy.env.example': 'X=',
      'package.json': '{"name":"shop"}',
      'requirements-dev.txt': 'pytest',
      'logo.svg': '<svg/>',
    });
    expect(listed(dir)).toEqual({
      '.env.example': 'env-example',
      'README.md': 'doc',
      'app.py': 'code',
      'data/catalog.jsonl': 'data',
      'data/items.json': 'data',
      'data/prices.csv': 'data',
      'data/settings.json': 'other',
      'deploy.env.example': 'env-example',
      'docs/guide.txt': 'doc',
      'logo.svg': 'other',
      'notes.rst': 'doc',
      'openapi.yaml': 'contract',
      'package.json': 'manifest',
      'prompts/system.txt': 'prompt',
      'requirements-dev.txt': 'manifest',
      'schemas/reply.json': 'contract',
      'src/app.ts': 'code',
      'src/writer-prompt.ts': 'prompt',
    });
  });

  it("leaves out yokla's own files: the profile it is measured against, and the cases", () => {
    const dir = repository({
      'yokla.profile.yaml': 'version: 1\n',
      'yokla.profile.proposed.yaml': 'version: 1\n',
      'yokla.config.yaml': 'version: 1\n',
      'yokla.baseline.json': '{}',
      'cases/acceptance.yaml': 'version: 1\ncases: []\n',
      'cases-tools/tools.json': '{"version":1,"cases":[]}',
      'runs/run.json': '{}',
      'yokla-data/customer/cache.json': '{}',
      'src/app.ts': 'export {};',
    });
    expect(listed(dir)).toEqual({ 'src/app.ts': 'code' });
    expect(inventory(dir, 100).skipped).toBe(6);
  });

  it('never enters hidden, dependency or build folders, nor follows links', () => {
    const dir = repository({
      '.git/config': '[core]',
      '.github/workflows/ci.yml': 'on: push',
      'node_modules/x/index.js': '',
      'vendor/y.go': '',
      'dist/index.js': '',
      'build/out.js': '',
      'coverage/lcov.info': '',
      'src/app.ts': 'export {};',
    });
    symlinkSync(join(dir, 'src'), join(dir, 'linked'));
    symlinkSync(join(dir, 'src/app.ts'), join(dir, 'linked-file.ts'));
    expect(listed(dir)).toEqual({ 'src/app.ts': 'code' });
  });

  it('never opens an environment file that may hold secrets', () => {
    const dir = repository({ '.env': 'KEY=secret', '.env.local': 'KEY=x', '.env.sample': 'KEY=' });
    expect(listed(dir)).toEqual({ '.env.sample': 'env-example' });
    expect(inventory(dir, 100).skipped).toBe(2);
  });

  it('leaves out binary files and files over the size limit', () => {
    const dir = repository({
      'image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
      'big.jsonl': Buffer.alloc(MAX_FILE_BYTES + 1, 0x41),
      'empty.txt': '',
    });
    expect(listed(dir)).toEqual({ 'empty.txt': 'other' });
    expect(inventory(dir, 100).skipped).toBe(2);
  });

  it('stops at the file cap, in path order, and says so', () => {
    const dir = repository({ 'c.ts': '', 'a.ts': '', 'b/z.ts': '', 'b/a.ts': '' });
    expect(inventory(dir, 2)).toEqual({
      files: [
        { path: 'a.ts', kind: 'code', bytes: 0 },
        { path: 'b/a.ts', kind: 'code', bytes: 0 },
      ],
      skipped: 0,
      capped: true,
    });
    expect(inventory(dir, 4).capped).toBe(false);
  });
});

describe('rowsOf (ADR-0047)', () => {
  it('reads JSON Lines, leaving out a line that is no object', () => {
    expect(rowsOf('a.jsonl', '{"id":"A"}\n\nnot json\n[1]\n{"id":"B"}\r\n')).toEqual([
      { id: 'A' },
      { id: 'B' },
    ]);
  });

  it('reads a JSON array of objects, and nothing else', () => {
    expect(rowsOf('a.json', '[{"id":"A"},2,{"id":"B"}]')).toEqual([{ id: 'A' }, { id: 'B' }]);
    expect(rowsOf('a.json', '{"id":"A"}')).toEqual([]);
    expect(rowsOf('a.json', 'not json')).toEqual([]);
  });

  it('reads CSV with a header line, quoted fields and doubled quotes', () => {
    expect(rowsOf('a.csv', 'id,name,note\nA,"Tent, 2-person","say ""hi"""\nB,Stove\n')).toEqual([
      { id: 'A', name: 'Tent, 2-person', note: 'say "hi"' },
      { id: 'B', name: 'Stove', note: '' },
    ]);
    expect(rowsOf('a.csv', '')).toEqual([]);
  });

  it('reads a file up to its first rows only', () => {
    const lines = Array.from({ length: MAX_ROWS + 5 }, (_, i) => `{"n":${String(i)}}`).join('\n');
    expect(rowsOf('a.jsonl', lines)).toHaveLength(MAX_ROWS);
    const csv = `n\n${Array.from({ length: MAX_ROWS + 5 }, (_, i) => String(i)).join('\n')}`;
    expect(rowsOf('a.csv', csv)).toHaveLength(MAX_ROWS);
  });
});
