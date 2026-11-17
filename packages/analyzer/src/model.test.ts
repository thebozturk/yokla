import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CustomerPrompt, OwnModel } from '@yokla/core';
import type { OwnReply } from '@yokla/runtime';
import { describe, expect, it } from 'vitest';
import type { InventoryFile } from './inventory.ts';
import { planModelStep, runModelStep, type ModelCaller } from './model.ts';

const model: OwnModel = {
  kind: 'openai-compatible',
  auth: 'api-key',
  url: 'http://127.0.0.1:1/v1',
  model: 'analyzer-1',
  temperature: 0,
  maxTokens: 500,
  timeoutMs: 1_000,
  price: { input: 1, output: 2 },
};

const FILES: Readonly<Record<string, string>> = {
  'README.md': 'Send `x-cache-bypass: 1` to skip the cache.',
  'src/limits.ts': 'export const LIMITS = { burstPerSecond: 3, perMinute: 120 };',
  'src/limits.test.ts': 'const LIMITS = { burstPerSecond: 99, perMinute: 999 };',
};

function repository(): { dir: string; files: InventoryFile[] } {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-model-'));
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return {
    dir,
    files: Object.entries(FILES).map(([path, text]) => ({
      path,
      kind: path.endsWith('.md') ? 'doc' : 'code',
      bytes: text.length,
    })),
  };
}

/** A model that answers each prompt with what `answer` finds in it, and counts its calls. */
function caller(
  answer: (chunk: string) => object[],
  usage: OwnReply['usage'] = { input: 1_000, output: 100 },
): ModelCaller & { calls: number } {
  const fake = {
    calls: 0,
    complete: (prompt: CustomerPrompt): Promise<OwnReply> => {
      fake.calls += 1;
      const entries = answer(prompt.messages[0]?.content ?? '');
      return Promise.resolve({
        text: JSON.stringify({ entries }),
        model: 'analyzer-1',
        usage,
        durationMs: 1,
      });
    },
  };
  return fake;
}

const finds = (chunk: string): object[] => [
  ...(chunk.includes('=== src/limits.ts')
    ? [
        {
          field: 'limits.perMinute',
          value: 120,
          file: 'src/limits.ts',
          line: 1,
          quote: 'export const LIMITS = { burstPerSecond: 3, perMinute: 120 };',
        },
        {
          field: 'limits.perHour',
          value: 7,
          file: 'src/limits.ts',
          line: 1,
          quote: 'perMinute: 120',
        },
      ]
    : []),
  ...(chunk.includes('=== README.md')
    ? [
        {
          field: 'cacheBypass.header',
          value: { name: 'x-cache-bypass', value: '1' },
          file: 'README.md',
          line: 1,
          quote: 'Send `x-cache-bypass: 1` to skip the cache.',
        },
      ]
    : []),
];

function run(
  options: {
    chunkTokens?: number;
    maxCostUsd?: number;
    fresh?: boolean;
    cacheDir?: string;
  } = {},
  model$: OwnModel = model,
  fake = caller(finds),
) {
  const { dir, files } = repository();
  const plan = planModelStep(dir, files, model$, ['en'], options.chunkTokens ?? 8_000, 200_000);
  const cacheDir = options.cacheDir ?? join(dir, 'yokla-data', 'analyzer');
  return {
    fake,
    cacheDir,
    plan,
    result: runModelStep({
      plan,
      model: model$,
      caller: fake,
      languages: ['en'],
      lines: (path) => (FILES[path] ?? '').split('\n'),
      maxCostUsd: options.maxCostUsd ?? 1,
      cacheDir,
      fresh: options.fresh ?? false,
    }),
  };
}

describe('the model step (ADR-0049)', () => {
  it('reads docs and code, never tests, and proposes only what passes its check', async () => {
    const { plan, result } = run();
    expect(plan.sent).toEqual(['README.md', 'src/limits.ts']);
    const step = await result;
    expect(
      step.entries.map((entry) => [entry.pointer, entry.value, entry.provenance.source]),
    ).toEqual([
      // In the order the reply gave them, within one chunk.
      ['/target/limits/perMinute', 120, 'code'],
      ['/target/cacheBypass', { kind: 'header', name: 'x-cache-bypass', value: '1' }, 'doc'],
    ]);
    expect(step.unverified).toEqual([
      {
        field: 'limits.perHour',
        file: 'src/limits.ts',
        line: 1,
        reason: 'the value is not in the quote',
      },
    ]);
    expect(step.summary).toEqual({
      model: 'analyzer-1',
      calls: 1,
      cached: 0,
      inputTokens: 1_000,
      outputTokens: 100,
      costUsd: (1_000 * 1 + 100 * 2) / 1_000_000,
      sent: ['README.md', 'src/limits.ts'],
      left: [],
      partial: false,
    });
  });

  it('answers from the cache the second time, at no cost, unless asked anew', async () => {
    const { cacheDir, result } = run();
    await result;
    expect(readdirSync(cacheDir)).toHaveLength(1);
    const again = run({ cacheDir });
    const cached = await again.result;
    expect(again.fake.calls).toBe(0);
    expect(cached.summary).toMatchObject({ calls: 0, cached: 1, costUsd: 0 });
    expect(cached.entries).toHaveLength(2);
    const fresh = run({ cacheDir, fresh: true });
    expect((await fresh.result).summary.calls).toBe(1);
  });

  it('sends no chunk once the spend reaches the cap, and says the step stopped', async () => {
    const { result, plan } = run({ chunkTokens: 30, maxCostUsd: 0.0001 });
    expect(plan.chunks.length).toBeGreaterThan(1);
    const step = await result;
    expect(step.summary).toMatchObject({ calls: 1, partial: true });
  });

  it('stops after a call whose cost is unknown: the cap could not be kept', async () => {
    const { result, plan } = run(
      { chunkTokens: 30 },
      model,
      caller(finds, { input: null, output: 5 }),
    );
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect((await result).summary).toMatchObject({
      calls: 1,
      partial: true,
      costUsd: null,
      inputTokens: null,
      outputTokens: 5,
    });
    const free: OwnModel = { ...model };
    Reflect.deleteProperty(free, 'price');
    expect((await run({ chunkTokens: 30 }, free).result).summary).toMatchObject({
      calls: 1,
      partial: true,
    });
  });
});
