// End to end: yokla runs the demo-shop's acceptance cases against the
// demo-shop running as its own process, over HTTP, like any other target.
// yokla never imports the demo-shop (design §19, layer rules).

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Results } from '@yokla/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;

let shop: ChildProcess | undefined;
let base = '';

beforeAll(async () => {
  const child = spawn(process.execPath, [join(DEMO, 'src/main.ts'), '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  shop = child;
  base = await new Promise<string>((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const url = /http:\/\/127\.0\.0\.1:\d+/u.exec(output)?.[0];
      if (url !== undefined) resolve(url);
    });
    child.on('exit', (code) => {
      reject(new Error(`demo-shop exited early with ${String(code)}`));
    });
  });
});

afterAll(() => {
  // Stop exactly the process this test started, by its handle.
  shop?.kill();
});

describe('yokla run against the demo-shop', () => {
  it(
    'runs every acceptance case, checks it and writes valid results.v1',
    { timeout: 60_000 },
    async () => {
      const out = join(mkdtempSync(join(tmpdir(), 'yokla-e2e-')), 'results.json');
      const lines: string[] = [];
      const io = {
        out: (line: string) => lines.push(line),
        err: (line: string) => lines.push(line),
      };
      const code = await main(
        [
          'run',
          '--profile',
          join(DEMO, 'yokla.profile.yaml'),
          '--cases',
          join(DEMO, 'cases'),
          '--target-url',
          `${base}/v1/chat`,
          '--out',
          out,
        ],
        io,
      );
      expect(code, lines.join('\n')).toBe(0);

      const results = Results.parse(JSON.parse(readFileSync(out, 'utf8')));
      expect(results.cases).toHaveLength(18);
      // Without defects every acceptance case passes.
      expect(results.summary.statuses).toEqual({ pass: 18 });
      expect(results.checks.find((c) => c.check === 'price-grounded')).toMatchObject({ failed: 0 });
      expect(results.checks.find((c) => c.check === 'price-grounded')?.applied).toBeGreaterThan(0);

      const relaxed = results.cases.find((c) => c.id === 'tents-under-500-tr')?.samples[0]
        ?.turns[0];
      expect(relaxed?.response?.text).toMatch(/^Bu kriterlere \(500,00 TL altı\)/u);
      expect(relaxed?.response?.evidence['products']?.[0]).toMatchObject({
        id: 'TNT-004',
        price: 899.5,
        stock: 0,
      });

      const followUp = results.cases.find((c) => c.id === 'cheaper-follow-up-en')?.samples[0]
        ?.turns;
      expect(followUp?.map((turn) => turn.response?.route)).toEqual([
        'product-search',
        'follow-up-cheapest',
      ]);
      expect(followUp?.[1]?.response?.evidence['products']).toMatchObject([{ id: 'JKT-003' }]);
    },
  );
});
