import { PassThrough } from 'node:stream';
import { z } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import { mcpServer, PROTOCOL_VERSIONS, serveLines, ToolError, type McpTool } from './protocol.ts';

const echo: McpTool = {
  name: 'echo',
  description: 'Says the word back.',
  input: z.strictObject({ word: z.string() }),
  output: z.object({ said: z.string() }),
  call: (input) => Promise.resolve({ said: z.object({ word: z.string() }).parse(input).word }),
};

const refusing: McpTool = {
  name: 'refuse',
  description: 'Always refuses.',
  input: z.strictObject({}),
  output: z.object({}),
  call: () => Promise.reject(new ToolError('the cap is spent')),
};

const handle = mcpServer({ name: 'yokla', version: '9.9.9', instructions: 'read me' }, [
  echo,
  refusing,
]);
const request = (id: number, method: string, params?: Record<string, unknown>) =>
  handle({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

/** A tool's failure as a result. */
const failed = (text: string) => ({ content: [{ type: 'text', text }], isError: true });

describe('mcpServer', () => {
  it('agrees on a protocol version it knows, and else offers its latest', async () => {
    const known = await request(1, 'initialize', { protocolVersion: '2025-06-18' });
    expect(known).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'yokla', version: '9.9.9' },
        instructions: 'read me',
      },
    });
    const later = await request(2, 'initialize', { protocolVersion: '2099-01-01' });
    expect(Reflect.get(Object(later?.result), 'protocolVersion')).toBe(PROTOCOL_VERSIONS[0]);
  });

  it('answers ping, and nothing to a notification', async () => {
    expect(await request(3, 'ping')).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    expect(await handle({ jsonrpc: '2.0', method: 'tools/call' })).toBeUndefined();
  });

  it('lists each tool with the JSON Schemas of its input and output', async () => {
    const listed = await request(4, 'tools/list');
    expect(Reflect.get(Object(listed?.result), 'tools')).toEqual([
      {
        name: 'echo',
        description: 'Says the word back.',
        inputSchema: {
          type: 'object',
          properties: { word: { type: 'string' } },
          required: ['word'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { said: { type: 'string' } },
          required: ['said'],
          additionalProperties: false,
        },
      },
      expect.objectContaining({ name: 'refuse' }) as unknown,
    ]);
  });

  it('answers a call with structured content and the same as JSON text', async () => {
    expect(await request(5, 'tools/call', { name: 'echo', arguments: { word: 'çadır' } })).toEqual({
      jsonrpc: '2.0',
      id: 5,
      result: {
        content: [{ type: 'text', text: '{"said":"çadır"}' }],
        structuredContent: { said: 'çadır' },
      },
    });
  });

  it("answers a tool's failure and bad arguments as results the agent can read", async () => {
    expect((await request(6, 'tools/call', { name: 'refuse' }))?.result).toEqual(
      failed('the cap is spent'),
    );
    expect(
      (await request(7, 'tools/call', { name: 'echo', arguments: { word: 1, extra: true } }))
        ?.result,
    ).toEqual(
      failed(
        'invalid arguments: word: Invalid input: expected string, received number; (arguments): Unrecognized key: "extra"',
      ),
    );
  });

  it('refuses what JSON-RPC calls an error: an unknown tool, method or request', async () => {
    expect(await request(8, 'tools/call', { name: 'nope' })).toEqual({
      jsonrpc: '2.0',
      id: 8,
      error: { code: -32602, message: 'no tool "nope"' },
    });
    expect((await request(9, 'tools/call', {}))?.error?.code).toBe(-32602);
    expect(await request(10, 'resources/list')).toEqual({
      jsonrpc: '2.0',
      id: 10,
      error: { code: -32601, message: 'no method "resources/list"' },
    });
    expect(await handle({ id: 11, method: 'ping' })).toEqual({
      jsonrpc: '2.0',
      id: 11,
      error: { code: -32600, message: 'not a JSON-RPC 2.0 request' },
    });
    expect((await handle([1, 2]))?.id).toBeNull();
  });
});

describe('serveLines', () => {
  it('answers each line, a ping while a tool still runs, and ends with its input', async () => {
    const waiting: (() => void)[] = [];
    const slow: McpTool = {
      ...echo,
      name: 'slow',
      call: () =>
        new Promise((resolve) => {
          waiting.push(() => {
            resolve({ said: 'done' });
          });
        }),
    };
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: unknown[] = [];
    output.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line));
        // The slow call answers only once the ping and the bad line are answered.
        if (lines.length === 2) for (const release of waiting) release();
      }
    });
    const served = serveLines(input, output, mcpServer({ name: 'y', version: '1' }, [slow]));
    input.write(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"slow","arguments":{"word":"x"}}}\n',
    );
    input.write('\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
    input.end('{ not json\n');
    await served;
    expect(lines).toHaveLength(3);
    expect(lines.slice(0, 2)).toEqual(
      expect.arrayContaining([
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'not JSON' } },
        { jsonrpc: '2.0', id: 2, result: {} },
      ]),
    );
    expect(lines[2]).toMatchObject({ id: 1, result: { structuredContent: { said: 'done' } } });
  });
});
