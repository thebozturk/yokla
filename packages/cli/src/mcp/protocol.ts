// The tools part of the Model Context Protocol (ADR-0041): JSON-RPC 2.0, one
// message per line over stdio. It answers initialize, ping, tools/list and
// tools/call, and ignores the notifications it doesn't need. Written here, with
// no dependency.

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from '@yokla/core';

/** The protocol versions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** A tool's failure the agent can act on: it is answered as a result with isError. */
export class ToolError extends Error {
  override readonly name = 'ToolError';
}

export interface McpTool {
  readonly name: string;
  readonly description: string;
  /** The arguments, a Zod object; validated before `call`. */
  readonly input: z.ZodType;
  /** What `call` returns, as structured content. */
  readonly output: z.ZodType;
  readonly call: (input: unknown) => Promise<unknown>;
}

type Id = string | number | null;

export interface Response {
  readonly jsonrpc: '2.0';
  readonly id: Id;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

const Request = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const CallParams = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const errorOf = (id: Id, code: number, message: string): Response => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a tool's arguments got wrong, path by path. */
function problems(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(arguments)'}: ${issue.message}`)
    .join('; ');
}

/** The JSON Schema of a tool's input or output, as tools/list gives it. */
function schemaOf(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const { $schema: _schema, ...rest } = z.toJSONSchema(schema, { io });
  return rest;
}

/**
 * Answers one message; undefined for a notification. A tool that fails comes
 * back as a result with isError, so the agent reads why.
 */
export function mcpServer(
  info: { readonly name: string; readonly version: string; readonly instructions?: string },
  tools: readonly McpTool[],
): (message: unknown) => Promise<Response | undefined> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return async (incoming) => {
    const parsed = Request.safeParse(incoming);
    if (!parsed.success) {
      const id: unknown = Reflect.get(Object(incoming), 'id');
      return errorOf(
        typeof id === 'string' || typeof id === 'number' ? id : null,
        -32600,
        'not a JSON-RPC 2.0 request',
      );
    }
    const { id, method, params } = parsed.data;
    // A notification gets no answer, whatever it is.
    if (id === undefined) return undefined;
    switch (method) {
      case 'initialize': {
        const asked = params?.['protocolVersion'];
        const protocolVersion = PROTOCOL_VERSIONS.find((version) => version === asked);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: protocolVersion ?? PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: info.name, version: info.version },
            ...(info.instructions === undefined ? {} : { instructions: info.instructions }),
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: schemaOf(tool.input, 'input'),
              outputSchema: schemaOf(tool.output, 'output'),
            })),
          },
        };
      case 'tools/call': {
        const call = CallParams.safeParse(params);
        if (!call.success) return errorOf(id, -32602, 'tools/call needs a tool name');
        const tool = byName.get(call.data.name);
        if (tool === undefined) return errorOf(id, -32602, `no tool "${call.data.name}"`);
        const failed = (text: string): Response => ({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text }], isError: true },
        });
        const input = tool.input.safeParse(call.data.arguments ?? {});
        if (!input.success) return failed(`invalid arguments: ${problems(input.error)}`);
        try {
          const output = await tool.call(input.data);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(output) }],
              structuredContent: output,
            },
          };
        } catch (error) {
          return failed(messageOf(error));
        }
      }
      default:
        return errorOf(id, -32601, `no method "${method}"`);
    }
  };
}

/**
 * Serves messages read from `input`, one per line, writing each answer to
 * `output` as one line. Messages are answered as they come, so a ping is
 * answered while a tool runs. Resolves once `input` ends and every answer is
 * written.
 */
export async function serveLines(
  input: Readable,
  output: Writable,
  handle: (message: unknown) => Promise<Response | undefined>,
): Promise<void> {
  const pending = new Set<Promise<void>>();
  const write = (response: Response | undefined) => {
    if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
  };
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      write(errorOf(null, -32700, 'not JSON'));
      continue;
    }
    const answered = handle(value).then(write, (error: unknown) => {
      write(errorOf(null, -32603, messageOf(error)));
    });
    pending.add(answered);
    void answered.finally(() => pending.delete(answered));
  }
  await Promise.all(pending);
}
