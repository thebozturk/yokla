import { describe, expect, it } from 'vitest';
import { collapse, decodeJsonEscapes, squeeze } from './match.ts';

describe('decodeJsonEscapes', () => {
  it('decodes unicode and simple escapes in one pass', () => {
    const bs = '\\';
    expect(decodeJsonEscapes(`Ay${bs}u015fe ${bs}"x${bs}" a${bs}/b`)).toBe('Ayşe "x" a/b');
    expect(decodeJsonEscapes(`a${bs}nb${bs}tc${bs}rd${bs}be${bs}ff`)).toBe('a\nb\tc\rd\be\ff');
    // An escaped backslash stays one backslash, and what follows it is text.
    expect(decodeJsonEscapes(`${bs}${bs}u0041`)).toBe(`${bs}u0041`);
    // Surrogate pairs come back as one character.
    expect(decodeJsonEscapes(`${bs}ud83d${bs}ude00`)).toBe('😀');
    expect(decodeJsonEscapes(`${bs}x ${bs}u12`)).toBe(`${bs}x ${bs}u12`);
  });
});

describe('collapse and squeeze', () => {
  it('collapse makes whitespace runs one space and trims', () => {
    expect(collapse('  kamp\n\t çadırı  ')).toBe('kamp çadırı');
  });

  it('squeeze drops whitespace, dots, dashes and parentheses only', () => {
    expect(squeeze('(0532) 111-22.33\n')).toBe('05321112233');
    expect(squeeze('a@b_c+d/e')).toBe('a@b_c+d/e');
  });
});
