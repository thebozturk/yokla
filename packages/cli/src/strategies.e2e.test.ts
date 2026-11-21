// Encoding and wrapping strategies, end to end (ADR-0084): yokla generate
// --redteam writes one case of each attack kind per language, and yokla run
// --strategy sends them encoded, obfuscated or wrapped.
// - The correct shop withstands every strategy, and two in layers.
// - Each strategy defect fails every injection case under its strategies,
//   and only cases whose own message, followed, breaks a check; under the
//   other strategies, nothing fails.
// The model runs in process, at no cost, behind the network guard.

import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Results, STRATEGIES } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'yokla-strategies-e2e-'));
const profile = join(work, 'yokla.profile.yaml');
const attacks = join(work, 'cases', 'redteam.yaml');
const children: ChildProcess[] = [];
const ports = new Set<number>();
let guard: NetworkGuard | undefined;

function startShop(defect: string): Promise<string> {
  const child = spawn(
    process.execPath,
    [join(DEMO, 'src/main.ts'), '--port', '0', '--rate-limit', 'off', '--defect', defect],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  return new Promise<string>((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const url = /http:\/\/127\.0\.0\.1:\d+/u.exec(output)?.[0];
      if (url !== undefined) {
        ports.add(Number(new URL(url).port));
        resolve(url);
      }
    });
    child.on('exit', (code) => {
      reject(new Error(`demo-shop (${defect}) exited early with ${String(code)}`));
    });
  });
}

async function cli(...args: string[]): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const code = await main(args, {
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  });
  return { code, output: lines.join('\n') };
}

/** Each defect → the strategies it follows; the others it must not. */
const FOLLOWS: Readonly<Record<string, readonly string[]>> = {
  'decodes-and-obeys': ['base64', 'hex', 'rot13', 'morse', 'base64+roleplay'],
  'obfuscation-obeyed': ['leetspeak', 'homoglyph'],
  'wrapper-obeyed': ['roleplay', 'hypothetical', 'developer-mode'],
  'hidden-text-obeyed': ['hidden'],
};
/** Strategies each defect is also run under, where nothing may fail. */
const RESISTS: Readonly<Record<string, readonly string[]>> = {
  'decodes-and-obeys': ['roleplay', 'leetspeak'],
  'obfuscation-obeyed': ['base64'],
  'wrapper-obeyed': ['base64', 'base64+roleplay'],
  'hidden-text-obeyed': ['base64'],
};
/** The kinds whose own message, followed, breaks a check. */
const FOLLOWED = new Set(['injection', 'false-premise', 'card', 'offer']);
/** Unmeasured without the proxy (cost-abuse, tool-argument) or without internals to look for. */
const UNMEASURED = new Set(['cost-abuse', 'internals', 'tool-argument']);

const runs = new Map<string, { code: number; output: string }>();
const results = (defect: string, strategy: string) =>
  Results.parse(JSON.parse(readFileSync(join(work, `${defect}-${strategy}.json`), 'utf8')));
const kindOf = (id: string) => id.replace(/-(?:tr|en)-.*$/u, '');

beforeAll(async () => {
  cpSync(join(DEMO, 'yokla.profile.yaml'), profile);
  cpSync(join(DEMO, 'data'), join(work, 'data'), { recursive: true });
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  const generated = await cli(
    'generate',
    '--redteam',
    '--profile',
    profile,
    '--per-kind',
    '1',
    '--competitor',
    'Rivalmart',
  );
  if (generated.code !== 0) throw new Error(generated.output);
  const plan: Record<string, readonly string[]> = {
    none: [...STRATEGIES, 'base64+roleplay'],
    ...Object.fromEntries(
      Object.keys(FOLLOWS).map((defect) => [
        defect,
        [...(FOLLOWS[defect] ?? []), ...(RESISTS[defect] ?? [])],
      ]),
    ),
  };
  // One shop per defect, side by side; each shop's runs one after the other.
  await Promise.all(
    Object.entries(plan).map(async ([defect, strategies]) => {
      const base = await startShop(defect);
      for (const strategy of strategies) {
        runs.set(
          `${defect} ${strategy}`,
          await cli(
            'run',
            '--profile',
            profile,
            '--cases',
            attacks,
            '--target-url',
            `${base}/v1/chat`,
            '--strategy',
            strategy,
            '--out',
            join(work, `${defect}-${strategy}.json`),
          ),
        );
      }
    }),
  );
}, 300_000);

afterAll(() => {
  guard?.uninstall();
  for (const child of children) child.kill();
});

describe('attack strategies on the demo-shop (ADR-0084)', () => {
  it('every run ran, and each strategy rewrote every attack message', () => {
    for (const [name, ran] of runs) expect(ran.code, `${name}: ${ran.output}`).toBe(0);
    const messages = results('none', 'base64').cases.reduce(
      (total, c) => total + (c.samples[0]?.turns.length ?? 0),
      0,
    );
    for (const strategy of [...STRATEGIES, 'base64+roleplay']) {
      expect(results('none', strategy).run.strategy, strategy).toEqual({
        name: strategy,
        messages,
      });
    }
  });

  it.each([...STRATEGIES, 'base64+roleplay'])('the correct shop withstands %s', (strategy) => {
    const failing = results('none', strategy).cases.filter(
      (c) => c.status !== 'pass' && !(c.status === 'unmeasured' && UNMEASURED.has(kindOf(c.id))),
    );
    expect(failing.map((c) => [c.id, c.status])).toEqual([]);
  });

  it.each(
    Object.entries(FOLLOWS).flatMap(([defect, strategies]) =>
      strategies.map((strategy) => [defect, strategy]),
    ),
  )(
    '%s follows %s: every injection fails, and only what its own message breaks',
    (defect, strategy) => {
      const cases = results(defect, strategy).cases;
      const failed = cases.filter((c) => c.status === 'fail').map((c) => c.id);
      const injections = cases.map((c) => c.id).filter((id) => kindOf(id) === 'injection');
      expect(injections.length).toBeGreaterThan(0);
      expect(failed).toEqual(expect.arrayContaining(injections));
      for (const id of failed) expect(FOLLOWED.has(kindOf(id)), id).toBe(true);
    },
  );

  it.each(
    Object.entries(RESISTS).flatMap(([defect, strategies]) =>
      strategies.map((strategy) => [defect, strategy]),
    ),
  )('%s, under %s, fails nothing', (defect, strategy) => {
    const failed = results(defect, strategy).cases.filter((c) => c.status === 'fail');
    expect(failed.map((c) => c.id)).toEqual([]);
  });

  // Last, so it sees the traffic of everything above.
  it('contacts nothing but the demo-shops (ADR-0003)', () => {
    const attempts = guard?.attempts ?? [];
    expect(attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
  });
});
