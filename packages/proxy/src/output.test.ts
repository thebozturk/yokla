import { describe, expect, it } from 'vitest';
import { readOutputText } from './output.ts';

const json = (value: unknown) => JSON.stringify(value);
const sse = (...events: unknown[]) =>
  `${events.map((event) => `data: ${json(event)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;

describe('readOutputText from a JSON answer (ADR-0033)', () => {
  it('reads chat completions content, as a string or as parts', () => {
    expect(
      readOutputText(
        'openai-compatible',
        json({ choices: [{ message: { role: 'assistant', content: 'Çadır 1.169,10 TL' } }] }),
        false,
        200,
      ),
    ).toBe('Çadır 1.169,10 TL');
    expect(
      readOutputText(
        'openai-compatible',
        json({
          choices: [
            {
              message: {
                content: [
                  { type: 'text', text: 'a' },
                  { type: 'text', text: 'b' },
                ],
              },
            },
          ],
        }),
        false,
        200,
      ),
    ).toBe('ab');
    // Only tool calls: the model said nothing as text.
    expect(
      readOutputText(
        'openai-compatible',
        json({ choices: [{ message: { content: null, tool_calls: [] } }] }),
        false,
        200,
      ),
    ).toBe('');
  });

  it('reads the Responses API message items, leaving function calls out', () => {
    expect(
      readOutputText(
        'openai-compatible',
        json({
          output: [
            { type: 'function_call', name: 'search', arguments: '{}' },
            { type: 'message', content: [{ type: 'output_text', text: 'Merhaba' }] },
          ],
        }),
        false,
        200,
      ),
    ).toBe('Merhaba');
  });

  it('reads Anthropic text blocks, leaving tool_use out', () => {
    expect(
      readOutputText(
        'anthropic',
        json({
          content: [
            { type: 'text', text: 'Bakıyorum. ' },
            { type: 'tool_use', name: 'search', input: { q: 'x' } },
            { type: 'text', text: 'Buldum.' },
          ],
        }),
        false,
        200,
      ),
    ).toBe('Bakıyorum. Buldum.');
  });

  it("reads Gemini's text parts, leaving thoughts and function calls out", () => {
    const answer = {
      candidates: [
        {
          content: {
            parts: [
              { text: 'düşünce', thought: true },
              { functionCall: { name: 'search', args: {} } },
              { text: 'Cevap' },
            ],
          },
        },
      ],
    };
    expect(readOutputText('gemini', json(answer), false, 200)).toBe('Cevap');
    expect(readOutputText('gemini', json([answer, answer]), true, 200)).toBe('CevapCevap');
  });

  it("gives '' for embeddings, an error or no answer, and null for a body it can't read", () => {
    expect(
      readOutputText('openai-compatible', json({ object: 'list', data: [] }), false, 200),
    ).toBe('');
    expect(readOutputText('openai-compatible', '{"error":{}}', false, 500)).toBe('');
    expect(readOutputText('openai-compatible', undefined, false, null)).toBe('');
    expect(readOutputText('openai-compatible', undefined, false, 200)).toBeNull();
    expect(readOutputText('openai-compatible', '{', false, 200)).toBeNull();
    expect(readOutputText('openai-compatible', json({ id: 'x' }), false, 200)).toBeNull();
    expect(readOutputText('anthropic', json({ id: 'x' }), false, 200)).toBeNull();
    expect(readOutputText('gemini', 'not json', false, 200)).toBeNull();
  });
});

describe('readOutputText from an event stream (ADR-0033)', () => {
  it('joins chat completions deltas', () => {
    const body = sse(
      { choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { content: 'Çadır ' } }] },
      { choices: [{ delta: { content: '1.169,10 TL' } }] },
      { choices: [], usage: { prompt_tokens: 1 } },
    );
    expect(readOutputText('openai-compatible', body, true, 200)).toBe('Çadır 1.169,10 TL');
  });

  it('joins Responses API text deltas, or takes the completed response', () => {
    expect(
      readOutputText(
        'openai-compatible',
        sse(
          { type: 'response.output_text.delta', delta: 'Mer' },
          { type: 'response.output_text.delta', delta: 'haba' },
        ),
        true,
        200,
      ),
    ).toBe('Merhaba');
    expect(
      readOutputText(
        'openai-compatible',
        sse(
          { type: 'response.output_text.delta', delta: 'Mer' },
          {
            type: 'response.completed',
            response: { output: [{ type: 'message', content: [{ text: 'Merhaba' }] }] },
          },
        ),
        true,
        200,
      ),
    ).toBe('Merhaba');
  });

  it('joins Anthropic text deltas, leaving tool input out', () => {
    const body = sse(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Bak' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ıyorum' } },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"q":' },
      },
    );
    expect(readOutputText('anthropic', body, true, 200)).toBe('Bakıyorum');
  });

  it('gives null for a stream with no readable event', () => {
    expect(readOutputText('openai-compatible', 'data: nope\n\n', true, 200)).toBeNull();
    expect(readOutputText('anthropic', '', true, 200)).toBeNull();
  });
});
