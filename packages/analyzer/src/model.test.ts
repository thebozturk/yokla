import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CustomerPrompt, OwnModel } from '@yokla/core';
import type { OwnReply } from '@yokla/runtime';
import { describe, expect, it } from 'vitest';
import type { InventoryFile } from './inventory.ts';
import {
  planModelStep,
  runModelStep,
  UNREAD_CUT,
  UNREAD_NOT_JSON,
  type ModelCaller,
} from './model.ts';

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
  shape: (text: string) => Pick<OwnReply, 'text' | 'cut'> = (text) => ({ text }),
): ModelCaller & { calls: number } {
  const fake = {
    calls: 0,
    complete: (prompt: CustomerPrompt): Promise<OwnReply> => {
      fake.calls += 1;
      const entries = answer(prompt.messages[0]?.content ?? '');
      return Promise.resolve({
        ...shape(JSON.stringify({ entries })),
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

const usage = { input: 1_000, output: 100 };
/** Replies cut at maxTokens: the first 40 characters, and the flag. */
const cutting = caller(finds, usage, (text) => ({ text: text.slice(0, 40), cut: true }));

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
      unread: [],
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

  it('names a chunk whose reply was cut, proposes none of it, and never caches it (ADR-0051)', async () => {
    const { cacheDir, result } = run({}, model, cutting);
    const step = await result;
    expect(step.entries).toEqual([]);
    expect(step.summary.unread).toEqual([
      { files: ['README.md', 'src/limits.ts'], reason: UNREAD_CUT },
    ]);
    // The spend counts all the same.
    expect(step.summary).toMatchObject({ calls: 1, costUsd: (1_000 * 1 + 100 * 2) / 1_000_000 });
    expect(existsSync(cacheDir) ? readdirSync(cacheDir) : []).toEqual([]);
    // The next run asks anew, and caches what it reads.
    const again = run({ cacheDir });
    expect((await again.result).summary).toMatchObject({ calls: 1, cached: 0, unread: [] });
    expect(readdirSync(cacheDir)).toHaveLength(1);
  });

  it('names a reply that is not the JSON asked for, even whole (ADR-0051)', async () => {
    const prose = caller(finds, usage, () => ({ text: 'I found nothing worth noting.' }));
    const step = await run({}, model, prose).result;
    expect(step.summary.unread).toEqual([
      { files: ['README.md', 'src/limits.ts'], reason: UNREAD_NOT_JSON },
    ]);
    // Cut but whole JSON is unread too: the flag decides.
    const flagged = caller(finds, usage, (text) => ({ text, cut: true }));
    expect((await run({}, model, flagged).result).summary.unread).toHaveLength(1);
  });

  it('takes a cached reply that cannot be read as a miss (ADR-0051)', async () => {
    const { cacheDir, result } = run();
    await result;
    const [file] = readdirSync(cacheDir);
    writeFileSync(
      join(cacheDir, file ?? ''),
      JSON.stringify({ text: '{"entries": [', model: 'm' }),
    );
    const again = run({ cacheDir });
    expect((await again.result).summary).toMatchObject({ calls: 1, cached: 0 });
  });

  it("keys the cache without maxTokens: raising it doesn't ask read chunks anew (ADR-0051)", async () => {
    const { cacheDir, result } = run();
    await result;
    const raised = run({ cacheDir }, { ...model, maxTokens: 8_000 });
    expect((await raised.result).summary).toMatchObject({ calls: 0, cached: 1 });
    expect(raised.fake.calls).toBe(0);
    const other = run({ cacheDir }, { ...model, temperature: 0.5 });
    expect((await other.result).summary).toMatchObject({ calls: 1, cached: 0 });
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
