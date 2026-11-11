import { describe, expect, it } from 'vitest';
import type { PromptMessage } from '../schema/proxy.ts';
import { redact, REDACTED, storePrompt, type PromptStorage } from './prompts.ts';

const prompt: PromptMessage[] = [
  { role: 'system', chars: 9, text: 'Be brief.' },
  { role: 'user', chars: 33, text: 'Telefonum 0532 111 22 33, a@b.com' },
];
/** A stand-in hash that shows what it was given. */
const hash = (text: string) => `#${text}`;

describe('storePrompt', () => {
  it('keeps role and length only with sizes', () => {
    expect(storePrompt(prompt, { store: 'sizes' }, hash)).toEqual([
      { role: 'system', chars: 9 },
      { role: 'user', chars: 33 },
    ]);
  });

  it('adds the hash of the text with hashed, and the text too with full', () => {
    expect(storePrompt(prompt, { store: 'hashed' }, hash)).toEqual([
      { role: 'system', chars: 9, sha256: '#Be brief.' },
      { role: 'user', chars: 33, sha256: '#Telefonum 0532 111 22 33, a@b.com' },
    ]);
    expect(storePrompt(prompt, { store: 'full' }, hash)).toEqual(
      prompt.map((message) => ({ ...message, sha256: `#${message.text ?? ''}` })),
    );
  });

  it('keeps the redacted text and no hash with redacted', () => {
    const storage: PromptStorage = {
      store: 'redacted',
      redact: ['\\d{4} \\d{3} \\d{2} \\d{2}', '\\S+@\\S+'],
    };
    expect(storePrompt(prompt, storage, hash)).toEqual([
      { role: 'system', chars: 9, text: 'Be brief.' },
      { role: 'user', chars: 33, text: `Telefonum ${REDACTED}, ${REDACTED}` },
    ]);
  });

  it('keeps a missing prompt missing, and a message without text at its size', () => {
    expect(storePrompt(null, { store: 'full' }, hash)).toBeNull();
    expect(storePrompt([{ role: 'tool', chars: 4 }], { store: 'full' }, hash)).toEqual([
      { role: 'tool', chars: 4 },
    ]);
  });
});

describe('redact', () => {
  it('replaces every match of each pattern, in order, in Unicode mode', () => {
    expect(redact('Ayşe ve Ayşe', ['Ayşe'])).toBe(`${REDACTED} ve ${REDACTED}`);
    expect(redact('çok çadır', ['\\p{L}+dır'])).toBe(`çok ${REDACTED}`);
    // A later pattern sees the text the earlier ones left.
    expect(redact('ab', ['a', '\\[redacted\\]b'])).toBe(REDACTED);
    expect(redact('text', [])).toBe('text');
  });
});
