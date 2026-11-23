// The library API (ADR-0093, E1 of ADR-0092): the demo-shop's suites run
// through the API, from its files and from objects, and through yokla run,
// against the correct shop and against one with a defect. Every case has the
// same status each way, and the gate gives the same verdict, as yokla gate's
// exit code says. The runs go under the egress guard (ADR-0003).

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, Results, z } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gate, loadProject, projectFrom, run } from './api.ts';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const PROFILE = join(DEMO, 'yokla.profile.yaml');
const CONFIG = join(DEMO, 'yokla.config.yaml');
const CASES = join(DEMO, 'cases');

const children: ChildProcess[] = [];
const shopPorts = new Set<number>();
let guard: NetworkGuard | undefined;

async function startShop(defect: string): Promise<string> {
  const child = spawn(
    process.execPath,
    [join(DEMO, 'src/main.ts'), '--port', '0', '--defect', defect],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  return new Promise<string>((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const url = /http:\/\/127\.0\.0\.1:\d+/u.exec(output)?.[0];
      if (url !== undefined) {
        shopPorts.add(Number(new URL(url).port));
        resolve(url);
      }
    });
    child.on('exit', (code) => {
      reject(new Error(`demo-shop (${defect}) exited early with ${String(code)}`));
    });
  });
}

/** A file of the demo-shop as an object, as a program would hold it. */
function objectOf(path: string): Record<string, unknown> {
  const parsed = parseConfig(readFileSync(path, 'utf8'), path, z.record(z.string(), z.unknown()));
  if (!parsed.ok) throw new Error(`${path} does not parse`);
  return parsed.value;
}

const CaseFile = z.looseObject({ cases: z.array(z.unknown()) });

/** The cases of every file in the demo-shop's case directory, as objects. */
function caseObjects(): unknown[] {
  const files = readdirSync(CASES).filter((file) => /\.(?:ya?ml|json)$/u.test(file));
  return files.toSorted().flatMap((file) => CaseFile.parse(objectOf(join(CASES, file))).cases);
}

interface Way {
  readonly statuses: readonly (readonly [string, string])[];
  readonly verdict: string;
}

const EXIT_CODES: Readonly<Record<string, number>> = { pass: 0, broken: 1, unjudgeable: 2 };

/** The cases' statuses and the gate's verdict, run each way against one shop. */
const ways = new Map<string, Readonly<Record<'cli' | 'files' | 'objects', Way>>>();

const statusesOf = (results: Results) => results.cases.map((c) => [c.id, c.status] as const);

async function runEachWay(defect: string): Promise<void> {
  const url = `${await startShop(defect)}/v1/chat`;
  const dir = mkdtempSync(join(tmpdir(), `yokla-library-${defect}-`));
  const out = join(dir, 'results.json');
  const silent = { out: () => undefined, err: () => undefined };
  const [cli, files, objects] = await Promise.all([
    (async (): Promise<Way> => {
      const args = ['--profile', PROFILE, '--config', CONFIG, '--cases', CASES];
      await main(['run', ...args, '--target-url', url, '--out', out], silent);
      const code = await main(['gate', '--results', out, '--config', CONFIG], silent);
      const verdict = Object.keys(EXIT_CODES).find((key) => EXIT_CODES[key] === code) ?? '?';
      return {
        statuses: statusesOf(Results.parse(JSON.parse(readFileSync(out, 'utf8')))),
        verdict,
      };
    })(),
    (async (): Promise<Way> => {
      const project = await loadProject({ profile: PROFILE, config: CONFIG, cases: [CASES] });
      const { results } = await run(project, { targetUrl: url });
      return {
        statuses: statusesOf(results),
        verdict: gate(results, { config: project.config }).verdict,
      };
    })(),
    (async (): Promise<Way> => {
      const project = await projectFrom({
        profile: objectOf(PROFILE),
        cases: caseObjects(),
        config: objectOf(CONFIG),
        dir: DEMO,
      });
      const { results } = await run(project, { targetUrl: url });
      return {
        statuses: statusesOf(results),
        verdict: gate(results, { config: project.config }).verdict,
      };
    })(),
  ]);
  ways.set(defect, { cli, files, objects });
}

beforeAll(async () => {
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && shopPorts.has(port),
  );
  await Promise.all(['none', 'fabricated-price'].map((defect) => runEachWay(defect)));
}, 240_000);

afterAll(() => {
  guard?.uninstall();
  // Stop exactly the processes these tests started, by their handles.
  for (const child of children) child.kill();
});

describe('the library API against the demo-shop (ADR-0093)', () => {
  it('reads every file of the demo-shop’s case directory as objects', () => {
    const files = ways.get('none')?.files.statuses.map(([id]) => id);
    expect(files?.length).toBeGreaterThan(0);
    expect(ways.get('none')?.objects.statuses.map(([id]) => id)).toEqual(files);
  });

  it('passes every case and the gate on the correct shop, each way', () => {
    const each = ways.get('none');
    expect(each?.cli.statuses.every(([, status]) => status === 'pass')).toBe(true);
    expect(each?.cli.verdict).toBe('pass');
    expect(each?.files).toEqual(each?.cli);
    expect(each?.objects).toEqual(each?.cli);
  });

  it('fails the same cases and breaks the gate under a defect, each way', () => {
    const each = ways.get('fabricated-price');
    expect(each?.cli.statuses.some(([, status]) => status === 'fail')).toBe(true);
    expect(each?.cli.verdict).toBe('broken');
    expect(each?.files).toEqual(each?.cli);
    expect(each?.objects).toEqual(each?.cli);
  });
});
