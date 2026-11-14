import { describe, expect, it } from 'vitest';
import type { FindingSubject } from '../schema/results.ts';
import { checkContext, mutate, proxyCall, stubLanguagePack, turnView } from '../testing.ts';
import { findOrigin } from './origin.ts';
import { runChecks } from './run.ts';
import type { Check, LanguagePack, ProxyCallView, TurnView } from './types.ts';

/** A small pack: "1169,10 TL" money, "14 gün" durations, Turkish-ish folding. */
const tr: LanguagePack = {
  ...stubLanguagePack('tr'),
  fold: (text) => text.toLocaleLowerCase('tr-TR').replaceAll('ı', 'i'),
  findMoney: (text) =>
    [...text.matchAll(/(\d+(?:,\d{1,2})?) ?TL/gu)].map((m) => ({
      amount: Number((m[1] ?? '').replace(',', '.')),
      currency: 'TRY',
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
    })),
  findDurations: (text) =>
    [...text.matchAll(/(\d+) gün/gu)].map((m) => ({
      amount: Number(m[1]),
      unit: 'day' as const,
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
    })),
};

/** An English pack: "$1169.10" money, with no currency for a bare "1169.10 dollars". */
const en: LanguagePack = {
  ...stubLanguagePack('en'),
  findMoney: (text) => [
    ...[...text.matchAll(/\$(\d+(?:\.\d{1,2})?)/gu)].map((m) => ({
      amount: Number(m[1]),
      currency: 'USD',
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
    })),
    ...[...text.matchAll(/(\d+(?:\.\d{1,2})?) dollars/gu)].map((m) => ({
      amount: Number(m[1]),
      currency: undefined,
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
    })),
  ],
};

type Message = NonNullable<ProxyCallView['prompt']>[number];
const system = (text: string): Message => ({ role: 'system', text });
const user = (text: string): Message => ({ role: 'user', text });
const tool = (text: string, name = 'search_products'): Message => ({
  role: 'tool',
  text,
  tool: name,
});
const call = (prompt: readonly Message[] | null, output: string | null = '') =>
  proxyCall({ prompt, output });
const proxied = (...calls: ProxyCallView[]): TurnView['proxy'] => ({ calls, costUsd: 0 });

const PRICE: FindingSubject = { kind: 'money', amount: 1169.1, currency: 'TRY' };

function origin(proxy: TurnView['proxy'], subject: FindingSubject = PRICE, lang = tr) {
  const languages = new Map([
    [tr.language, tr],
    [en.language, en],
  ]);
  return findOrigin(checkContext(turnView({ proxy }), { lang, languages }), subject);
}

describe('findOrigin (ADR-0033)', () => {
  it('is input when a message a call sent holds the value, naming the call, role and tool', () => {
    const proxy = proxied(
      call([system('Sen bir asistansın.'), user('çadır var mı?')], ''),
      call([user('çadır var mı?'), tool('Kamp Çadırı: 1169,10 TL')], 'Kamp Çadırı 1169,10 TL'),
    );
    expect(origin(proxy)).toEqual({
      stage: 'input',
      call: 1,
      role: 'tool',
      tool: 'search_products',
      match: 'money',
    });
    expect(origin(proxied(call([system('Kampanya: 1169,10 TL')])))).toEqual({
      stage: 'input',
      call: 0,
      role: 'system',
      match: 'money',
    });
  });

  it('is model when no message holds it and a call answered it', () => {
    const proxy = proxied(
      call([user('çadır?')], 'ara: çadır'),
      call([user('çadır?'), tool('{"price": 1299}')], 'Kamp Çadırı 1169,10 TL'),
    );
    expect(origin(proxy)).toEqual({ stage: 'model', call: 1, match: 'money' });
  });

  it('is app when every message and answer was read and none holds it', () => {
    const proxy = proxied(call([user('çadır?')], 'Kamp Çadırı 1299 TL'));
    expect(origin(proxy)).toEqual({ stage: 'app' });
    expect(origin(proxied())).toEqual({ stage: 'app', reason: 'the turn made no model call' });
  });

  it('is unknown without proxy data, or when an unread message or answer could hold it', () => {
    expect(origin(undefined)).toEqual({
      stage: 'unknown',
      reason: 'no model proxy data for this turn',
    });
    expect(origin(proxied(call([user('çadır?')]), call(null, 'Kamp Çadırı 1169,10 TL')))).toEqual({
      stage: 'unknown',
      call: 1,
      reason: 'the messages a model call sent are not known',
    });
    expect(origin(proxied(call([user('çadır?')], null)))).toEqual({
      stage: 'unknown',
      call: 0,
      reason: "a model call's answer is not known",
    });
    // A message read with the value settles it, whatever another call couldn't show.
    expect(origin(proxied(call(null), call([tool('1169,10 TL')])))).toMatchObject({
      stage: 'input',
      call: 1,
    });
  });

  it('counts a bare number only inside JSON, and labels it', () => {
    expect(origin(proxied(call([tool('{"items":[{"price":1169.1}]}')])))).toEqual({
      stage: 'input',
      call: 0,
      role: 'tool',
      tool: 'search_products',
      match: 'number',
    });
    expect(origin(proxied(call([tool('Results:\n{"price": 1169.10}')])))).toMatchObject({
      match: 'number',
    });
    // In plain text, a bare number is not money (design §17).
    expect(origin(proxied(call([user('1169.1 adet')], '')))).toEqual({ stage: 'app' });
    expect(origin(proxied(call([user('ok')], '{"total": 1169.1}')))).toEqual({
      stage: 'model',
      call: 0,
      match: 'number',
    });
  });

  it('compares amounts to the cent, and currencies only when both name one', () => {
    expect(origin(proxied(call([system('1169,11 TL')])))).toEqual({ stage: 'app' });
    expect(origin(proxied(call([system('$1169.10')])))).toEqual({ stage: 'app' });
    expect(origin(proxied(call([system('1169.10 dollars')])))).toMatchObject({ stage: 'input' });
    expect(
      origin(proxied(call([system('$1169.10')])), { kind: 'money', amount: 1169.1 }),
    ).toMatchObject({ stage: 'input', match: 'money' });
  });

  it("tries the answer's own pack first, then the others", () => {
    const usd: FindingSubject = { kind: 'money', amount: 49.9, currency: 'USD' };
    expect(origin(proxied(call([system('Promo price: $49.90')])), usd, tr)).toMatchObject({
      stage: 'input',
      match: 'money',
    });
  });

  it('finds durations by amount and unit, and text folded with JSON escapes decoded', () => {
    const days: FindingSubject = { kind: 'duration', amount: 30, unit: 'day' };
    expect(origin(proxied(call([system('İade süresi 30 gün.')])), days)).toMatchObject({
      stage: 'input',
      match: 'duration',
    });
    expect(origin(proxied(call([system('İade süresi 14 gün.')], '30 gün')), days)).toEqual({
      stage: 'model',
      call: 0,
      match: 'duration',
    });
    const internal: FindingSubject = { kind: 'text', text: 'İç  Sunucu' };
    expect(origin(proxied(call([tool('{"note":"iç\\nsunucu"}')])), internal)).toMatchObject({
      stage: 'input',
      match: 'text',
    });
    expect(origin(proxied(call([tool('dış sunucu')])), internal)).toEqual({ stage: 'app' });
  });

  it('moves stage when the value is taken away from where it was found (mutations)', () => {
    const base = proxied(
      call([system('Sen bir asistansın.'), tool('Kamp Çadırı: 1169,10 TL')], 'Çadır 1169,10 TL'),
    );
    expect(origin(base)).toMatchObject({ stage: 'input' });
    const noInput = mutate(base, (proxy) =>
      proxied(
        ...(proxy?.calls ?? []).map((c) =>
          call(
            (c.prompt ?? []).map((m) => ({ ...m, text: m.text.replace('1169,10', '1299') })),
            c.output,
          ),
        ),
      ),
    );
    expect(origin(noInput)).toMatchObject({ stage: 'model' });
    const noOutput = mutate(noInput, (proxy) =>
      proxied(...(proxy?.calls ?? []).map((c) => call(c.prompt, 'Çadır 1299 TL'))),
    );
    expect(origin(noOutput)).toEqual({ stage: 'app' });
  });
});

function naming(verdict: 'pass' | 'fail'): Check {
  return {
    id: 'naming',
    description: 'names a price',
    run: () => ({
      applicable: true,
      findings: [
        {
          dimension: 'fabrication',
          verdict,
          severity: 'high',
          message: 'm',
          subject: PRICE,
        },
      ],
    }),
  };
}

describe('runChecks with subjects (ADR-0033)', () => {
  const context = checkContext(turnView({ proxy: proxied(call([user('çadır?')], '1169,10 TL')) }), {
    lang: tr,
  });

  it('gives a failing finding its subject and origin', () => {
    expect(runChecks([naming('fail')], context)[0]?.findings[0]).toEqual({
      dimension: 'fabrication',
      verdict: 'fail',
      severity: 'high',
      message: 'm',
      subject: PRICE,
      origin: { stage: 'model', call: 0, match: 'money' },
    });
  });

  it('leaves a passing finding as it was', () => {
    expect(runChecks([naming('pass')], context)[0]?.findings[0]).toEqual({
      dimension: 'fabrication',
      verdict: 'pass',
      severity: 'high',
      message: 'm',
    });
  });
});
