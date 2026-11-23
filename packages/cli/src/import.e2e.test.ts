// Import (ADR-0097, E5 of ADR-0092), on the demo-shop. A run, correct and
// with fabricated-price, exported as rows (ADR-0096) and imported back
// through the guide's mapping, has every case's status. Cases imported from
// another tool's dataset run against the shop with fabricated-price: the
// checks that need no expectation fail one, and the gate passes while they
// are proposed, and breaks once a person approves them. Under the egress
// guard.

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig, z, type Results } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  gate,
  importCases,
  importResults,
  loadProject,
  projectFrom,
  resultRows,
  run,
} from './api.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const IMPORTS = new URL('../../../examples/imports/', import.meta.url).pathname;
const DEFECTS = ['none', 'fabricated-price'] as const;

const children: ChildProcess[] = [];
const shopPorts = new Set<number>();
let guard: NetworkGuard | undefined;
const urls = new Map<string, string>();
const runs = new Map<string, Results>();

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

/** A YAML or JSON file of the demo-shop or the import fixtures, as an object. */
function objectOf(path: string): unknown {
  const parsed = parseConfig(readFileSync(path, 'utf8'), path, z.unknown());
  if (!parsed.ok) throw new Error(`${path} does not parse`);
  return parsed.value;
}

/** Each case's id, status and suite. */
function statuses(results: Results) {
  return results.cases.map((c) => [c.id, c.status, c.suite]);
}

const ran = (defect: string): Results => {
  const results = runs.get(defect);
  if (results === undefined) throw new Error(`no run against ${defect}`);
  return results;
};

beforeAll(async () => {
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && shopPorts.has(port),
  );
  const project = await loadProject({
    profile: join(DEMO, 'yokla.profile.yaml'),
    config: join(DEMO, 'yokla.config.yaml'),
    cases: [join(DEMO, 'cases')],
  });
  const started = await Promise.all(DEFECTS.map((defect) => startShop(defect)));
  await Promise.all(
    DEFECTS.map(async (defect, index) => {
      const url = `${started[index] ?? ''}/v1/chat`;
      urls.set(defect, url);
      const { results } = await run(project, { targetUrl: url });
      runs.set(defect, results);
    }),
  );
}, 240_000);

afterAll(() => {
  guard?.uninstall();
  // Stop exactly the processes these tests started, by their handles.
  for (const child of children) child.kill();
});

describe('import on the demo-shop (ADR-0097)', () => {
  it.each(DEFECTS)(
    'imports the rows of the run against %s back with every case’s status',
    (defect) => {
      const results = ran(defect);
      const text = resultRows(results)
        .map((row) => `${JSON.stringify(row)}\n`)
        .join('');
      const { results: imported, problems } = importResults(
        text,
        objectOf(join(IMPORTS, 'yokla-rows.mapping.yaml')),
        { format: 'jsonl', source: 'rows.jsonl' },
      );
      expect(problems).toEqual([]);
      expect(statuses(imported)).toEqual(statuses(results));
      expect(imported.cases.some((c) => c.status === 'fail')).toBe(defect === 'fabricated-price');
    },
  );

  it('runs cases imported from a dataset, which gate only once a person approves them', async () => {
    const { cases, problems } = importCases(
      readFileSync(join(IMPORTS, 'dataset.yaml'), 'utf8'),
      objectOf(join(IMPORTS, 'dataset.mapping.yaml')),
      { format: 'yaml', source: 'dataset.yaml' },
    );
    expect(problems).toEqual([]);
    expect(cases.map((c) => c['id'])).toEqual(['tents', 'cheaper-tent', 'greeting']);
    const config = objectOf(join(DEMO, 'yokla.config.yaml'));
    // A price the shop makes up fails price-grounded, which needs no expectation.
    const targetUrl = urls.get('fabricated-price') ?? '';
    const proposed = await projectFrom({
      profile: objectOf(join(DEMO, 'yokla.profile.yaml')),
      cases,
      config,
      dir: DEMO,
    });
    const asProposed = (await run(proposed, { targetUrl })).results;
    expect(asProposed.cases.every((c) => c.review === 'proposed')).toBe(true);
    expect(gate(asProposed, { config: proposed.config }).verdict).toBe('pass');

    const approved = await projectFrom({
      profile: objectOf(join(DEMO, 'yokla.profile.yaml')),
      cases: cases.map((c) => ({
        ...c,
        provenance: { source: 'import', evidence: 'dataset.yaml', status: 'approved' },
      })),
      config,
      dir: DEMO,
    });
    const asApproved = (await run(approved, { targetUrl })).results;
    expect(statuses(asApproved).map(([id, status]) => [id, status])).toEqual(
      statuses(asProposed).map(([id, status]) => [id, status]),
    );
    expect(asApproved.cases.find((c) => c.id === 'tents')?.status).toBe('fail');
    const outcome = gate(asApproved, { config: approved.config });
    expect(outcome.verdict).toBe('broken');
    expect(outcome.breaches.flatMap((breach) => breach.cases)).toContain('tents');
  }, 120_000);
});
