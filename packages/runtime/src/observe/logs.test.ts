import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandError } from '../process/command.ts';
import {
  correlate,
  observedFields,
  parseLogLines,
  readField,
  readLogText,
  stripAnsi,
  type LogConfig,
} from './logs.ts';

const ESC = '\u001B';
const node = process.execPath;

function config(change: Partial<LogConfig> = {}): LogConfig {
  return {
    source: { kind: 'file', path: 'app.log' },
    match: [],
    correlate: { by: 'request-id' },
    fields: {},
    ...change,
  };
}

/** A line as a framework logger writes it to a terminal: prefix, context and colours. */
function framework(context: string, value: unknown): string {
  return (
    `${ESC}[32m[App] 7  - ${ESC}[39m11/10/2026, 2:00:00 PM ${ESC}[32m    LOG${ESC}[39m ` +
    `${ESC}[33m[${context}] ${ESC}[39m${ESC}[32m${JSON.stringify(value)}${ESC}[39m`
  );
}

describe('stripAnsi', () => {
  it('removes colour codes and keeps the text', () => {
    expect(stripAnsi(`${ESC}[1;32mok${ESC}[0m done`)).toBe('ok done');
    expect(stripAnsi('plain {"a":1}')).toBe('plain {"a":1}');
  });

  it('keeps an escape that does not start a code, and drops an unfinished code', () => {
    expect(stripAnsi(`a${ESC}b`)).toBe(`a${ESC}b`);
    expect(stripAnsi(`x${ESC}[12`)).toBe('x');
  });
});

describe('parseLogLines', () => {
  it('reads the JSON after a prefix and colour codes', () => {
    const text = `${framework('Telemetry', { requestId: 'r1', costUsd: 0.5 })}\n`;
    expect(parseLogLines(text, config())).toEqual([{ requestId: 'r1', costUsd: 0.5 }]);
  });

  it('skips lines without JSON or with broken JSON, and reads CRLF lines', () => {
    const text = 'starting up\n{"a":\r\n{"b":1}\r\n';
    expect(parseLogLines(text, config())).toEqual([{ b: 1 }]);
  });

  it('keeps only the lines that contain the marker, when one is given', () => {
    const text = [framework('Telemetry', { a: 1 }), framework('Http', { a: 2 })].join('\n');
    expect(parseLogLines(text, config({ contains: '[Telemetry]' }))).toEqual([{ a: 1 }]);
    expect(parseLogLines(text, config())).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('keeps only the lines where every match holds', () => {
    const text = [
      { context: 'Telemetry', v: 1 },
      { context: 'Telemetry', v: 2 },
      { context: 'Http', v: 1 },
      { v: 1 },
    ]
      .map((value) => JSON.stringify(value))
      .join('\n');
    const match = [
      { path: '$.context', equals: 'Telemetry' },
      { path: '$.v', equals: 1 },
    ];
    expect(parseLogLines(text, config({ match }))).toEqual([{ context: 'Telemetry', v: 1 }]);
  });
});

describe('readField', () => {
  const line = {
    id: 'r1',
    calls: [{ costUsd: 0.25 }, { costUsd: 0.5 }],
    unpriced: [{ costUsd: 0.25 }, { costUsd: null }],
    flags: [true, false],
    yes: [true, true],
  };

  it('reads the first value of a path, or null', () => {
    expect(readField(line, '$.id')).toBe('r1');
    expect(readField(line, '$.calls[*].costUsd')).toBe(0.25);
    expect(readField(line, '$.missing')).toBeNull();
  });

  it('reduces the selected values', () => {
    expect(readField(line, { from: '$.calls[*].costUsd', reduce: 'sum' })).toBe(0.75);
    expect(readField(line, { from: '$.calls[*]', reduce: 'count' })).toBe(2);
    expect(readField(line, { from: '$.calls[*].costUsd', reduce: 'first' })).toBe(0.25);
    expect(readField(line, { from: '$.flags[*]', reduce: 'any' })).toBe(true);
    expect(readField(line, { from: '$.flags[*]', reduce: 'all' })).toBe(false);
    expect(readField(line, { from: '$.yes[*]', reduce: 'all' })).toBe(true);
  });

  it('sums to null when any selected value is not a number', () => {
    expect(readField(line, { from: '$.unpriced[*].costUsd', reduce: 'sum' })).toBeNull();
    expect(readField(line, { from: '$.calls[*]', reduce: 'sum' })).toBeNull();
  });

  it('reduces nothing to a neutral value, never to a pass', () => {
    const none = '$.none[*]';
    expect(readField(line, { from: none, reduce: 'sum' })).toBe(0);
    expect(readField(line, { from: none, reduce: 'count' })).toBe(0);
    expect(readField(line, { from: none, reduce: 'first' })).toBeNull();
    expect(readField(line, { from: none, reduce: 'any' })).toBe(false);
    expect(readField(line, { from: none, reduce: 'all' })).toBe(false);
  });

  it('maps every configured field', () => {
    const fields = { id: '$.id', cost: { from: '$.calls[*].costUsd', reduce: 'sum' as const } };
    expect(observedFields(line, config({ fields }))).toEqual({ id: 'r1', cost: 0.75 });
  });
});

describe('correlate', () => {
  const a = { requestId: 'a', n: 1 };
  const b = { requestId: 'b', n: 2 };

  it('ties turns to lines by the request id, in $.requestId by default', () => {
    const turns = [
      { requestId: 'b', targetId: undefined },
      { requestId: 'z', targetId: undefined },
      { requestId: undefined, targetId: 'a' },
    ];
    expect(correlate([a, b], config(), turns)).toEqual([b, undefined, undefined]);
  });

  it('reads the id from the configured field, and accepts numeric ids', () => {
    const line = { meta: { id: 7 } };
    const c = config({ correlate: { by: 'request-id', field: '$.meta.id' } });
    expect(correlate([line], c, [{ requestId: '7', targetId: undefined }])).toEqual([line]);
  });

  it("ties turns by the target's own id when asked to", () => {
    const line = { requestId: 't1' };
    const turns = [
      { requestId: 't1', targetId: 'x' },
      { requestId: 'x', targetId: 't1' },
    ];
    expect(correlate([line], config({ correlate: { by: 'target-id' } }), turns)).toEqual([
      undefined,
      line,
    ]);
  });

  it('ties turns by order, leaving turns past the last line without one', () => {
    const turns = Array.from({ length: 3 }, () => ({ requestId: undefined, targetId: undefined }));
    expect(correlate([a, b], config({ correlate: { by: 'order' } }), turns)).toEqual([
      a,
      b,
      undefined,
    ]);
  });
});

describe('readLogText', () => {
  const startedAt = new Date('2026-11-10T12:00:00.000Z');

  it('reads a file relative to the profile directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-logs-'));
    writeFileSync(join(dir, 'app.log'), '{"a":1}\n');
    expect(await readLogText(config(), { startedAt, cwd: dir })).toBe('{"a":1}\n');
  });

  it('runs a command in the profile directory with the run start filled in', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'yokla-logs-')));
    const run = [
      node,
      '-e',
      'process.stdout.write(JSON.stringify([process.argv[1], process.cwd()]))',
      'since={{startedAt}}',
    ];
    const text = await readLogText(
      config({ source: { kind: 'command', run, timeoutMs: 10_000 } }),
      { startedAt, cwd: dir },
    );
    expect(JSON.parse(text)).toEqual(['since=2026-11-10T12:00:00.000Z', dir]);
  });

  it('fails when the command fails', async () => {
    const run = [node, '-e', 'process.exit(3)'];
    await expect(
      readLogText(config({ source: { kind: 'command', run, timeoutMs: 10_000 } }), {
        startedAt,
        cwd: tmpdir(),
      }),
    ).rejects.toBeInstanceOf(CommandError);
  });
});
