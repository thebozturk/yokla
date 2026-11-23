import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { mcpCommand } from '../commands/mcp.ts';
import { loadFiles } from '../prepare.ts';

const PROFILE = `version: 1
target:
  name: t
  adapter: http
  request: { url: 'http://127.0.0.1:1/chat', body: { message: '{{message}}' } }
  response: { text: $.answer }
languages: [tr]
domain: ecommerce
`;

const PROXY =
  "modelProxy:\n  upstreams: [{ id: fake, kind: openai-compatible, upstream: 'http://127.0.0.1:2/v1' }]\n";

const CASE = (id: string) =>
  `version: 1\ncases:\n  - id: ${id}\n    suite: quality\n    language: tr\n    turns: [{ user: merhaba }]\n`;

function workspace(profile: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-mcp-command-'));
  writeFileSync(join(dir, 'yokla.profile.yaml'), profile);
  mkdirSync(join(dir, 'cases'));
  writeFileSync(join(dir, 'cases', 'a.yaml'), CASE('a'));
  return dir;
}

function capture() {
  const err: string[] = [];
  return { io: { out: () => undefined, err: (line: string) => err.push(line) }, err };
}

describe('yokla mcp (ADR-0041)', () => {
  it('refuses a session that can spend without a cap, and a loose replay without a cassette', async () => {
    const dir = workspace(PROFILE + PROXY);
    const profile = join(dir, 'yokla.profile.yaml');
    const uncapped = capture();
    expect(await mcpCommand(['--profile', profile], uncapped.io, '0')).toBe(2);
    expect(uncapped.err).toEqual([
      'this session can spend money on model calls: start yokla mcp with --max-cost <usd>, its cap over every run (ADR-0041)',
    ]);
    const loose = capture();
    expect(await mcpCommand(['--profile', profile, '--replay-loose'], loose.io, '0')).toBe(2);
    expect(loose.err).toEqual(['--replay-loose needs --replay']);
    const zero = capture();
    expect(await mcpCommand(['--profile', profile, '--max-cost', '0'], zero.io, '0')).toBe(2);
    expect(zero.err).toEqual(['--max-cost must be a positive number of USD']);
    expect(await mcpCommand(['--frobnicate'], capture().io, '0')).toBe(2);
  });

  it('serves over the streams it is given, stdout holding protocol messages only', async () => {
    const dir = workspace(PROFILE + PROXY);
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
    const { io, err } = capture();
    const served = mcpCommand(
      ['--profile', join(dir, 'yokla.profile.yaml'), '--max-cost', '0.5'],
      io,
      '1.2.3',
      { input, output },
    );
    input.write(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}\n',
    );
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    input.end('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_cases"}}\n');
    expect(await served).toBe(0);
    const lines = written.join('').split('\n').filter(Boolean);
    const answers = lines.map((line): unknown => JSON.parse(line));
    expect(answers).toHaveLength(3);
    expect(answers[0]).toMatchObject({
      id: 1,
      result: { protocolVersion: '2025-11-25', serverInfo: { name: 'yokla', version: '1.2.3' } },
    });
    const tools: unknown = Reflect.get(Object(Reflect.get(Object(answers[1]), 'result')), 'tools');
    expect(
      Array.isArray(tools)
        ? tools.map((tool: unknown) => String(Reflect.get(Object(tool), 'name')))
        : [],
    ).toEqual(['list_cases', 'run_cases', 'explain_finding', 'shrink_case', 'verify_fix']);
    expect(answers[2]).toMatchObject({
      id: 3,
      result: { structuredContent: { cases: [{ id: 'a', turns: 1 }] } },
    });
    expect(err).toEqual(['yokla mcp: serving 1 cases of t over stdio, capped at 0.5 USD']);
  });

  it("serves a session that can't spend without a cap", async () => {
    const dir = workspace(PROFILE);
    const input = new PassThrough();
    const { io } = capture();
    const served = mcpCommand(['--profile', join(dir, 'yokla.profile.yaml')], io, '0', {
      input,
      output: new PassThrough(),
    });
    input.end();
    expect(await served).toBe(0);
  });

  it('loads a case file the session wrote once, even when its directory is a case path', async () => {
    const dir = workspace(PROFILE);
    writeFileSync(join(dir, 'cases', 'a.min.yaml'), CASE('a-min'));
    const elsewhere = join(dir, 'b.min.yaml');
    writeFileSync(elsewhere, CASE('b-min'));
    const prepared = await loadFiles({
      profile: join(dir, 'yokla.profile.yaml'),
      alsoCases: [join(dir, 'cases', 'a.min.yaml'), elsewhere],
    });
    // A directory loads its files in name order; a file it holds isn't loaded twice.
    expect(prepared.cases.map((c) => c.id)).toEqual(['a-min', 'a', 'b-min']);
  });
});
