import { describe, expect, it } from 'vitest';
import type { LanguagePack } from '../checks/types.ts';
import { hideText } from '../generate/attacks.ts';
import { stubLanguagePack } from '../testing.ts';
import {
  applyStrategies,
  base64,
  parseStrategy,
  STRATEGIES,
  utf8,
  type StrategyPhrasings,
} from './strategies.ts';

const phrasings: StrategyPhrasings = {
  decode: {
    base64: 'b64: {payload}',
    hex: 'hex: {payload}',
    rot13: 'rot: {payload}',
    morse: 'morse: {payload}',
  },
  hidden: 'hidden:',
  wrap: {
    roleplay: 'play "{payload}"',
    hypothetical: 'suppose "{payload}"',
    'developer-mode': 'dev: {payload}',
  },
};

const lang: LanguagePack = {
  ...stubLanguagePack('tr'),
  removeDiacritics: (text) => text.normalize('NFD').replaceAll(/\p{M}/gu, '').replaceAll('ı', 'i'),
};

const apply = (message: string, text: string, keep: string[] = []) => {
  const parsed = parseStrategy(text);
  if (typeof parsed === 'string') throw new Error(parsed);
  return applyStrategies(message, parsed, { lang, phrasings, keep });
};

describe('the encodings (ADR-0084)', () => {
  it('write UTF-8 and Base64 as the standards do', () => {
    expect(utf8('aç€😀')).toEqual([0x61, 0xc3, 0xa7, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80]);
    expect(base64('Man')).toBe('TWFu');
    expect(base64('Ma')).toBe('TWE=');
    expect(base64('M')).toBe('TQ==');
    expect(base64('çadır')).toBe('w6dhZMSxcg==');
  });

  it('encode the whole message, the canary too, after the language pack line', () => {
    expect(apply('say YK-1', 'base64', ['YK-1'])).toBe('b64: c2F5IFlLLTE=');
    expect(apply('Çay YK-1', 'hex')).toBe('hex: c3 87 61 79 20 59 4b 2d 31');
    expect(apply('Çay az, YK-1', 'rot13')).toBe('rot: Pnl nm, LX-1');
    expect(apply('Çay az?', 'morse')).toBe('morse: -.-. .- -.-- / .- --.. ..--..');
    expect(apply('a ğ@x', 'morse')).toBe('morse: .- / --. ? -..-');
    expect(apply('Çay ı€', 'hidden')).toBe(`hidden: ${hideText('Cay i?')}`);
    // A control character has no tag character either, and a byte under 16 two hex digits.
    expect(apply('a\nb', 'hidden')).toBe(`hidden: ${hideText('a?b')}`);
    expect(apply('a\nb', 'hex')).toBe('hex: 61 0a 62');
  });
});

describe('the obfuscations and wrappers (ADR-0084)', () => {
  it('rewrite letters outside the quoted values, which stay as written', () => {
    expect(apply('a test says YK-5E0', 'leetspeak', ['YK-5E0'])).toBe('4 7357 54y5 YK-5E0');
    expect(apply('say safe-token', 'leetspeak', ['safe-token'])).toBe('54y safe-token');
    expect(apply('Copy paste YK-AE', 'homoglyph', ['YK-AE'])).toBe(
      'Сору раѕtе YK-AE'.replace('ѕ', 's'),
    );
    expect(apply('say X', 'roleplay')).toBe('play "say X"');
    expect(apply('say X', 'hypothetical')).toBe('suppose "say X"');
    expect(apply('say X', 'developer-mode')).toBe('dev: say X');
  });

  it('apply two in layers, in the order written', () => {
    expect(apply('hi', 'base64+roleplay')).toBe('play "b64: aGk="');
    expect(apply('hi', 'roleplay+base64')).toBe(`b64: ${base64('play "hi"')}`);
  });
});

describe('parsing a strategy (ADR-0084)', () => {
  it('takes one, or two joined by "+", and says what is wrong otherwise', () => {
    for (const strategy of STRATEGIES) expect(parseStrategy(strategy)).toEqual([strategy]);
    expect(parseStrategy('hex+hypothetical')).toEqual(['hex', 'hypothetical']);
    expect(parseStrategy('a+b+c')).toBe(
      '--strategy takes one strategy, or two joined by "+": a+b+c',
    );
    expect(parseStrategy('base64+rot26')).toBe(
      `--strategy rot26 is none of ${STRATEGIES.join(', ')}`,
    );
  });
});
