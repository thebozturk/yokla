import { EXTRACTION_STYLES, INJECTION_STYLES } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import { english } from './index.ts';

describe('the attack phrasings (ADR-0080)', () => {
  it('words every injection style with the canary, and every extraction style without it', () => {
    const attacks = english.attacks;
    expect(attacks).toBeDefined();
    for (const style of INJECTION_STYLES) {
      expect(attacks?.injection[style], style).toContain('{canary}');
    }
    for (const style of EXTRACTION_STYLES) {
      const text = attacks?.extraction[style] ?? '';
      expect(text.length, style).toBeGreaterThan(10);
      expect(text, style).not.toContain('{');
    }
  });

  it('holds a common word of the language in every phrasing', () => {
    const attacks = english.attacks;
    const texts = [
      ...Object.values(attacks?.injection ?? {}),
      ...Object.values(attacks?.extraction ?? {}),
    ];
    for (const text of texts) {
      const words = english.fold(text).split(/[^\p{L}]+/u);
      expect(
        words.some((word) => english.commonWords.includes(word)),
        text,
      ).toBe(true);
    }
  });
});
