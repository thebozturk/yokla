import { describe, expect, it } from 'vitest';
import type { PromptMessage, ToolCall } from '../schema/proxy.ts';
import { redact, REDACTED, storePrompt, storeToolCalls, type PromptStorage } from './prompts.ts';

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

describe('storeToolCalls (ADR-0025)', () => {
  const calls: ToolCall[] = [
    { name: 'search_products', chars: 16, arguments: '{"q":"çadır"}' },
    { name: 'add_to_cart', chars: 25, arguments: '{"email":"a@b.com","n":1}' },
  ];

  it('keeps the name and length only with sizes, the default', () => {
    expect(storeToolCalls(calls, { store: 'sizes' }, hash)).toEqual([
      { name: 'search_products', chars: 16 },
      { name: 'add_to_cart', chars: 25 },
    ]);
  });

  it('adds the hash with hashed, and the arguments too with full', () => {
    expect(storeToolCalls(calls, { store: 'hashed' }, hash)?.[0]).toEqual({
      name: 'search_products',
      chars: 16,
      sha256: '#{"q":"çadır"}',
    });
    expect(storeToolCalls(calls, { store: 'full' }, hash)?.[1]).toEqual({
      name: 'add_to_cart',
      chars: 25,
      sha256: '#{"email":"a@b.com","n":1}',
      arguments: '{"email":"a@b.com","n":1}',
    });
  });

  it('keeps redacted arguments and no hash with redacted', () => {
    expect(
      storeToolCalls(calls, { store: 'redacted', redact: ['[a-z]+@[a-z.]+'] }, hash)?.[1],
    ).toEqual({ name: 'add_to_cart', chars: 25, arguments: `{"email":"${REDACTED}","n":1}` });
  });

  it('keeps unknown calls unknown, and a call without arguments at its size', () => {
    expect(storeToolCalls(null, { store: 'full' }, hash)).toBeNull();
    expect(storeToolCalls([{ name: 'x', chars: 3 }], { store: 'full' }, hash)).toEqual([
      { name: 'x', chars: 3 },
    ]);
  });
});

describe('storePrompt keeps the tool a result answers (ADR-0026)', () => {
  it('as a name, whatever the store mode', () => {
    const result: PromptMessage[] = [
      { role: 'tool', chars: 2, text: '{}', tool: 'search_products' },
    ];
    for (const store of ['sizes', 'hashed', 'redacted', 'full'] as const) {
      expect(storePrompt(result, { store, redact: ['x'] }, hash)?.[0]?.tool).toBe(
        'search_products',
      );
    }
  });
});
