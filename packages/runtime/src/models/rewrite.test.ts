import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateTokens, transformPrompt, type CustomerPrompt, type OwnModel } from '@yokla/core';
import { stubLanguagePack } from '@yokla/core/testing';
import { describe, expect, it } from 'vitest';
import type { OwnReply } from './client.ts';
import { Rewriter, type OwnSpendCount, type RewriteCaller, type RewriteJob } from './rewrite.ts';

const model: OwnModel = {
  kind: 'openai-compatible',
  auth: 'api-key',
  url: 'http://127.0.0.1:1/v1',
  model: 'transform-1',
  temperature: 0,
  maxTokens: 100,
  timeoutMs: 1_000,
  price: { input: 1, output: 2 },
};

/** A model that answers by `rewrite`, and counts its calls. */
function caller(
  rewrite: (message: string, system: string) => string,
  change: Partial<OwnReply> = {},
): RewriteCaller & { calls: number } {
  const fake = {
    calls: 0,
    complete: (prompt: CustomerPrompt): Promise<OwnReply> => {
      fake.calls += 1;
      return Promise.resolve({
        text: rewrite(prompt.messages[0]?.content ?? '', prompt.system),
        model: 'transform-1',
        usage: { input: 100, output: 10 },
        durationMs: 1,
        ...change,
      });
    },
  };
  return fake;
}

const job = (change: Partial<RewriteJob> = {}): RewriteJob => ({
  key: 'tents|0',
  message: '500 TL altı çadır',
  language: 'tr',
  other: 'en',
  keep: ['500 TL'],
  kinds: ['paraphrase'],
  ...change,
});

const spend = (): OwnSpendCount => ({ calls: 0, cached: 0, costUsd: 0, unknown: false });

const rewriter = (fake: RewriteCaller, cacheDir = mkdtempSync(join(tmpdir(), 'yokla-rw-'))) =>
  new Rewriter({ model, env: {}, cacheDir, caller: fake });

const polite = (message: string) => `Merhaba, ${message}`;

/** A language pack with a few common words, as language-match counts them. */
const pack = (language: string, commonWords: string[]) => ({
  ...stubLanguagePack(language),
  commonWords,
});

describe('the rewriter (ADR-0059)', () => {
  it('rewrites a message by each kind in turn, the second on the first one’s text', async () => {
    const fake = caller((message, system) =>
      system.includes('code-switch') ? message.replace('çadır', 'tent') : polite(message),
    );
    const spent = spend();
    const results = await rewriter(fake).run(
      [job({ kinds: ['paraphrase', 'code-switch'] })],
      spent,
      undefined,
    );
    expect(results.get('tents|0')).toEqual({
      text: 'Merhaba, 500 TL altı tent',
      changedBy: ['paraphrase', 'code-switch'],
      refused: [],
    });
    expect(spent).toEqual({
      calls: 2,
      cached: 0,
      costUsd: (2 * (100 * 1 + 10 * 2)) / 1_000_000,
      unknown: false,
    });
  });

  it('sends a rewrite that fails its check as written, and says why', async () => {
    const results = await rewriter(caller(() => 'beş yüz TL altı çadır')).run(
      [job()],
      spend(),
      undefined,
    );
    expect(results.get('tents|0')).toEqual({
      text: '500 TL altı çadır',
      changedBy: [],
      refused: [{ kind: 'paraphrase', why: '"500 TL" was lost' }],
    });
  });

  it('answers from the cache at no cost, and plans only what the cache lacks', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'yokla-rw-'));
    const first = caller(polite);
    const jobs = [job(), job({ key: 'tents|1', message: 'Çadır önerir misin?', keep: [] })];
    const planned = rewriter(first, cacheDir).plan(jobs);
    expect(planned).toMatchObject({
      model: 'transform-1',
      url: 'http://127.0.0.1:1/v1',
      messages: 2,
      calls: 2,
      cached: 0,
    });
    expect(planned.upperUsd).toBeGreaterThan(0);
    await rewriter(first, cacheDir).run(jobs, spend(), undefined);
    expect(readdirSync(cacheDir)).toHaveLength(2);
    const second = caller(() => 'never asked');
    expect(rewriter(second, cacheDir).plan(jobs)).toMatchObject({
      calls: 0,
      cached: 2,
      upperUsd: 0,
    });
    const spent = spend();
    const again = await rewriter(second, cacheDir).run(jobs, spent, undefined);
    expect(second.calls).toBe(0);
    expect(again.get('tents|1')?.text).toBe('Merhaba, Çadır önerir misin?');
    expect(spent).toEqual({ calls: 2, cached: 2, costUsd: 0, unknown: false });
  });

  it('counts a step after an uncached one as a call, whatever the cache holds', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'yokla-rw-'));
    // The cache holds a code-switch of the message as written, not its paraphrase.
    await rewriter(
      caller((message) => message.replace('çadır', 'tent')),
      cacheDir,
    ).run([job({ kinds: ['code-switch'] })], spend(), undefined);
    expect(
      rewriter(caller(polite), cacheDir).plan([job({ kinds: ['paraphrase', 'code-switch'] })]),
    ).toMatchObject({ calls: 2, cached: 0 });
  });

  it("bounds each call by its prompt and maxTokens at the model's price", () => {
    const plan = rewriter(caller(polite)).plan([job()]);
    const prompt = transformPrompt({
      kind: 'paraphrase',
      message: '500 TL altı çadır',
      language: 'tr',
      keep: ['500 TL'],
    });
    const input = estimateTokens(prompt.system) + estimateTokens('500 TL altı çadır');
    expect(plan.upperUsd).toBeCloseTo((input * 1 + 100 * 2) / 1_000_000, 12);
    const free: OwnModel = { ...model };
    Reflect.deleteProperty(free, 'price');
    expect(
      new Rewriter({ model: free, env: {}, cacheDir: tmpdir(), caller: caller(polite) }).plan([
        job(),
      ]).upperUsd,
    ).toBeNull();
  });

  it('asks nothing once the spend reaches the cap, or after a call of unknown cost', async () => {
    const fake = caller(polite);
    const jobs = [job(), job({ key: 'tents|1', message: 'Çadır önerir misin?', keep: [] })];
    const capped = await rewriter(fake).run(jobs, spend(), 0.0001);
    expect(fake.calls).toBe(1);
    expect(capped.get('tents|1')?.refused).toEqual([
      { kind: 'paraphrase', why: 'the cost cap was reached' },
    ]);
    const unknown = caller(polite, { usage: { input: null, output: 10 } });
    const spent = spend();
    const results = await rewriter(unknown).run(jobs, spent, 1);
    expect(spent.unknown).toBe(true);
    expect(unknown.calls).toBe(1);
    expect(results.get('tents|1')?.text).toBe('Çadır önerir misin?');
  });

  it('never caches a reply cut at maxTokens, and says so', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'yokla-rw-'));
    const results = await rewriter(caller(polite, { cut: true }), cacheDir).run(
      [job()],
      spend(),
      undefined,
    );
    expect(results.get('tents|0')?.refused).toEqual([
      { kind: 'paraphrase', why: 'the reply stopped at maxTokens' },
    ]);
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  it('refuses a code-switch that left its language, by the packs it is given (ADR-0060)', async () => {
    const languages = new Map([
      ['tr', pack('tr', ['bir', 'var', 'mı'])],
      ['en', pack('en', ['do', 'you', 'have', 'any'])],
    ]);
    const fake = caller(() => 'Do you have any tent, do you have any?');
    const results = await new Rewriter({
      model,
      env: {},
      cacheDir: mkdtempSync(join(tmpdir(), 'yokla-rw-')),
      caller: fake,
      languages,
    }).run(
      [job({ kinds: ['code-switch'], message: 'Bir çadır var mı?', keep: [] })],
      spend(),
      undefined,
    );
    expect(results.get('tents|0')?.refused).toEqual([
      { kind: 'code-switch', why: 'the reply is no longer in tr' },
    ]);
  });

  it('leaves code-switch out with one language, asking nothing', async () => {
    const fake = caller(polite);
    const one = job({ kinds: ['code-switch'], other: undefined });
    expect(rewriter(fake).plan([one])).toMatchObject({ calls: 0, cached: 0 });
    const results = await rewriter(fake).run([one], spend(), undefined);
    expect(fake.calls).toBe(0);
    expect(results.get('tents|0')?.refused).toEqual([
      { kind: 'code-switch', why: 'the profile has one language' },
    ]);
  });
});
