import { EXTRACTION_STYLES, hideText, INJECTION_STYLES, INTERNALS_STYLES } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import { english } from './index.ts';

describe('the attack phrasings (ADR-0080)', () => {
  it('words every injection style with the canary, and every extraction style without it', () => {
    const attacks = english.attacks;
    expect(attacks).toBeDefined();
    for (const style of INJECTION_STYLES) {
      const text =
        style === 'hidden-text' ? attacks?.hidden.instruction : attacks?.injection[style];
      expect(text, style).toContain('{canary}');
    }
    // The hidden instruction is ASCII, so every character has a tag character (ADR-0082).
    expect(() => hideText(attacks?.hidden.instruction ?? 'x')).not.toThrow();
    for (const style of INTERNALS_STYLES) {
      expect(attacks?.internals[style].length, style).toBeGreaterThan(10);
    }
    expect(attacks?.costAbuse.length).toBeGreaterThan(20);
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
      attacks?.hidden.visible ?? '',
      attacks?.hidden.instruction ?? '',
      ...Object.values(attacks?.extraction ?? {}),
      attacks?.costAbuse ?? '',
      ...Object.values(attacks?.internals ?? {}),
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
