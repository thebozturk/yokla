import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cacheBypass } from './cache-bypass.ts';
import { CommandError, runCommand, runCommandOrFail } from './command.ts';

const node = process.execPath;

describe('runCommand', () => {
  it('runs a program with arguments and returns its output', async () => {
    const result = await runCommand(
      [node, '-e', 'process.stdout.write(process.argv.slice(1).join("|"))', 'a', 'b c'],
      {
        timeoutMs: 10_000,
      },
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: 'a|b c' });
  });

  it('passes shell syntax through literally', async () => {
    const tricky = ['$(echo pwned)', '; rm -rf /tmp/x', '`id`', '*'];
    const result = await runCommand(
      [node, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...tricky],
      {
        timeoutMs: 10_000,
      },
    );
    expect(JSON.parse(result.stdout)).toEqual(tricky);
  });

  it('returns a non-zero exit code instead of throwing', async () => {
    const result = await runCommand([node, '-e', 'process.stderr.write("boom"); process.exit(3)'], {
      timeoutMs: 10_000,
    });
    expect(result).toMatchObject({ exitCode: 3, stderr: 'boom' });
  });

  it('reports a missing program', async () => {
    await expect(
      runCommand(['yokla-no-such-program-xyz'], { timeoutMs: 10_000 }),
    ).rejects.toMatchObject({
      kind: 'not-found',
    });
  });

  it('stops a command that runs too long', async () => {
    await expect(
      runCommand([node, '-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 200 }),
    ).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('refuses output beyond the limit', async () => {
    await expect(
      runCommand([node, '-e', 'process.stdout.write("x".repeat(5000))'], {
        timeoutMs: 10_000,
        maxOutputBytes: 1_000,
      }),
    ).rejects.toMatchObject({ kind: 'too-large' });
  });

  it('rejects an empty command', async () => {
    await expect(runCommand([], { timeoutMs: 1_000 })).rejects.toBeInstanceOf(CommandError);
  });
});

describe('runCommandOrFail', () => {
  it('fails with the end of stderr when the exit code is not 0', async () => {
    await expect(
      runCommandOrFail([node, '-e', 'console.error("line1\\nline2"); process.exit(2)'], {
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/exited with 2: line1 \| line2/u);
  });
});

describe('cacheBypass', () => {
  it('adds a header for the header kind', async () => {
    const bypass = cacheBypass({ kind: 'header', name: 'X-Cache-Bypass', value: '1' }, undefined);
    expect(bypass.headers).toEqual({ 'x-cache-bypass': '1' });
    await expect(bypass.prepare()).resolves.toBeUndefined();
  });

  it('runs the command in the given directory before each cold sample', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-bypass-'));
    const script = 'require("fs").appendFileSync("flushes.txt", "x")';
    const bypass = cacheBypass(
      { kind: 'command', run: [node, '-e', script], timeoutMs: 10_000 },
      dir,
    );
    await bypass.prepare();
    await bypass.prepare();
    expect(readFileSync(join(dir, 'flushes.txt'), 'utf8')).toBe('xx');
    expect(bypass.headers).toEqual({});
  });

  it('fails when the command fails, so a cache hit is never measured as cold', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-bypass-'));
    writeFileSync(join(dir, 'unused'), '');
    const bypass = cacheBypass(
      { kind: 'command', run: [node, '-e', 'process.exit(1)'], timeoutMs: 10_000 },
      dir,
    );
    await expect(bypass.prepare()).rejects.toMatchObject({ kind: 'failed' });
  });

  it('does nothing for none', async () => {
    const bypass = cacheBypass({ kind: 'none' }, undefined);
    expect([bypass.headers, bypass.description]).toEqual([{}, 'none']);
    await expect(bypass.prepare()).resolves.toBeUndefined();
  });
});
