import { describe, expect, it } from 'vitest';
import { readPrompt } from './prompts.ts';

const json = (value: unknown) => JSON.stringify(value);
/** Role and text only: chars is checked once, apart. */
const roles = (prompt: ReturnType<typeof readPrompt>) =>
  prompt?.map(({ role, text }) => ({ role, text })) ?? prompt;

describe('readPrompt for chat completions', () => {
  it('reads every role, text parts and tool-call arguments', () => {
    const body = json({
      model: 'm',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'developer', content: [{ type: 'text', text: 'Use TL.' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Çadır' },
            { type: 'image_url', image_url: { url: 'data:x' } },
            { type: 'text', text: 'öner' },
            { type: 'text' },
          ],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 't', function: { name: 'search', arguments: '{"q":"çadır"}' } },
            { id: 'u', function: { name: 'list' } },
          ],
        },
        { role: 'tool', content: '[{"name":"Kamp Çadırı"}]' },
        { role: 'assistant', content: 'Bir', function_call: { name: 'f', arguments: '{}' } },
        { role: 'function', name: 'f', content: 'ok' },
      ],
    });
    expect(roles(readPrompt('openai-compatible', '/chat/completions', body))).toEqual([
      { role: 'system', text: 'Be brief.' },
      { role: 'system', text: 'Use TL.' },
      { role: 'user', text: 'Çadır\nöner' },
      { role: 'assistant', text: '{"q":"çadır"}' },
      { role: 'tool', text: '[{"name":"Kamp Çadırı"}]' },
      { role: 'assistant', text: 'Bir\n{}' },
      { role: 'tool', text: 'ok' },
    ]);
  });

  it('counts the characters of each text', () => {
    const body = json({ messages: [{ role: 'user', content: 'Merhaba' }] });
    expect(readPrompt('openai-compatible', '/chat/completions', body)).toEqual([
      { role: 'user', chars: 7, text: 'Merhaba' },
    ]);
  });

  it('gives up on a message it cannot place, rather than leave it out', () => {
    for (const messages of [[{ role: 'critic', content: 'x' }], ['not an object']]) {
      expect(readPrompt('openai-compatible', '/chat/completions', json({ messages }))).toBeNull();
    }
  });
});

describe('readPrompt for the Responses API', () => {
  it('reads instructions as the system and a text input as the user', () => {
    const body = json({ instructions: 'Be brief.', input: 'Çadır öner' });
    expect(roles(readPrompt('openai-compatible', '/responses', body))).toEqual([
      { role: 'system', text: 'Be brief.' },
      { role: 'user', text: 'Çadır öner' },
    ]);
    expect(
      roles(readPrompt('openai-compatible', '/responses', json({ instructions: 'x' }))),
    ).toEqual([{ role: 'system', text: 'x' }]);
  });

  it('reads input items: messages, function calls and their output', () => {
    const body = json({
      input: [
        { role: 'developer', content: 'Use TL.' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Çadır' }] },
        { type: 'reasoning', summary: [] },
        { type: 'function_call', name: 'search', arguments: '{"q":"çadır"}' },
        { type: 'function_call', name: 'search' },
        { type: 'function_call_output', call_id: 'c', output: '[]' },
        { role: 'assistant', content: [{ type: 'output_text', text: 'Bir' }] },
      ],
    });
    expect(roles(readPrompt('openai-compatible', '/responses', body))).toEqual([
      { role: 'system', text: 'Use TL.' },
      { role: 'user', text: 'Çadır' },
      { role: 'assistant', text: '{"q":"çadır"}' },
      { role: 'assistant', text: '' },
      { role: 'tool', text: '[]' },
      { role: 'assistant', text: 'Bir' },
    ]);
  });

  it('gives up on input it cannot read', () => {
    for (const input of [42, [1], [{ role: 'critic', content: 'x' }]]) {
      expect(readPrompt('openai-compatible', '/responses', json({ input }))).toBeNull();
    }
  });
});

describe('readPrompt for embeddings', () => {
  it('reads each input text, and gives up on token ids', () => {
    const path = '/embeddings';
    expect(roles(readPrompt('openai-compatible', path, json({ input: 'çadır' })))).toEqual([
      { role: 'input', text: 'çadır' },
    ]);
    expect(roles(readPrompt('openai-compatible', path, json({ input: ['a', 'b'] })))).toEqual([
      { role: 'input', text: 'a' },
      { role: 'input', text: 'b' },
    ]);
    expect(readPrompt('openai-compatible', path, json({ input: [101, 102] }))).toBeNull();
    // The same body elsewhere is a Responses API input.
    expect(roles(readPrompt('openai-compatible', '/responses', json({ input: 'çadır' })))).toEqual([
      { role: 'user', text: 'çadır' },
    ]);
  });
});

describe('readPrompt for Anthropic Messages', () => {
  it('reads the system, text blocks, tool use and tool results', () => {
    const body = json({
      system: [{ type: 'text', text: 'Be brief.' }],
      messages: [
        { role: 'user', content: 'Çadır öner' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Arıyorum.' },
            { type: 'tool_use', id: 't', name: 'search', input: { q: 'çadır' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: '[]' }] },
            // Only text blocks are text, whatever other fields a block has.
            { type: 'image', source: {}, text: 'not a text block' },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't', content: 'ok' },
            { type: 'text', text: 'Başka?' },
          ],
        },
        { role: 'user', content: [{ type: 'image', source: {} }] },
      ],
    });
    expect(roles(readPrompt('anthropic', '/messages', body))).toEqual([
      { role: 'system', text: 'Be brief.' },
      { role: 'user', text: 'Çadır öner' },
      { role: 'assistant', text: 'Arıyorum.\n{"q":"çadır"}' },
      { role: 'tool', text: '[]' },
      { role: 'user', text: 'Başka?' },
      { role: 'tool', text: 'ok' },
      { role: 'user', text: '' },
    ]);
    expect(
      roles(readPrompt('anthropic', '/messages', json({ system: 'S', messages: [] }))),
    ).toEqual([{ role: 'system', text: 'S' }]);
    const bare = json({
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'now' }] }],
    });
    expect(roles(readPrompt('anthropic', '/messages', bare))).toEqual([
      { role: 'assistant', text: 'null' },
    ]);
  });

  it('gives up on a body without messages, or with a message it cannot place', () => {
    expect(readPrompt('anthropic', '/messages', json({ system: 'S' }))).toBeNull();
    for (const messages of [
      [{ role: 'system', content: 'x' }],
      [3],
      [{ role: 'user', content: ['x'] }],
    ]) {
      expect(readPrompt('anthropic', '/messages', json({ messages }))).toBeNull();
    }
  });
});

describe('readPrompt', () => {
  it('reads no messages from an empty body, and gives up on one it cannot read', () => {
    expect(readPrompt('openai-compatible', '/models', '')).toEqual([]);
    expect(readPrompt('openai-compatible', '/chat/completions', undefined)).toBeNull();
    expect(readPrompt('openai-compatible', '/chat/completions', '{"messages":')).toBeNull();
    expect(readPrompt('openai-compatible', '/chat/completions', '[]')).toBeNull();
    expect(readPrompt('openai-compatible', '/responses', '"text"')).toBeNull();
    expect(readPrompt('openai-compatible', '/moderations', json({ text: 'x' }))).toBeNull();
  });
});
