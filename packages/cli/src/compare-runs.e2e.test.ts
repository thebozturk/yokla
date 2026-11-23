// Two runs side by side (ADR-0095, E3 of ADR-0092): the demo-shop's cases run
// against the correct shop twice and once against a shop with
// fabricated-price, through the library API. Correct then the defect: every
// case the defect fails gains a price-grounded row, and nothing else is new;
// the page shows both runs' answers. Reversed, the same rows are gone. The
// correct shop twice: no case's findings differ. Under the egress guard.

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Results } from '@yokla/core';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compare, comparisonHtml, loadProject, run } from './api.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;

const children: ChildProcess[] = [];
const shopPorts = new Set<number>();
let guard: NetworkGuard | undefined;
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

/** Escaped as the page escapes text. */
function escaped(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const get = (name: string): Results => {
  const results = runs.get(name);
  if (results === undefined) throw new Error(`no run ${name}`);
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
  const [correct, defect] = await Promise.all([startShop('none'), startShop('fabricated-price')]);
  const named = [
    ['correct', correct],
    ['again', correct],
    ['defect', defect],
  ] as const;
  await Promise.all(
    named.map(async ([name, url]) => {
      const { results } = await run(project, { targetUrl: `${url}/v1/chat` });
      runs.set(name, results);
    }),
  );
}, 240_000);

afterAll(() => {
  guard?.uninstall();
  // Stop exactly the processes these tests started, by their handles.
  for (const child of children) child.kill();
});

describe('two runs side by side on the demo-shop (ADR-0095)', () => {
  it('names each case the defect fails as newly failing price-grounded, and nothing else', () => {
    const defect = get('defect');
    const failing = defect.cases.filter((c) => c.status === 'fail').map((c) => c.id);
    expect(failing.length).toBeGreaterThan(0);
    const comparison = compare([get('correct'), defect]);
    const gained = comparison.cases.flatMap((c) =>
      (c.findings ?? [])
        .filter((row) => (row.failed[0] ?? 0) === 0 && (row.failed[1] ?? 0) > 0)
        .map((row) => [c.id, row.check, row.dimension] as const),
    );
    // A case can gain the row on more than one turn.
    expect([...new Set(gained.map(([id]) => id))].toSorted()).toEqual(failing.toSorted());
    expect(new Set(gained.map(([, check, dimension]) => `${check} ${dimension}`))).toEqual(
      new Set(['price-grounded fabrication']),
    );
  });

  it('shows both runs’ answers of such a case on the page', () => {
    const correct = get('correct');
    const defect = get('defect');
    const id = defect.cases.find((c) => c.status === 'fail')?.id ?? '';
    const html = comparisonHtml(compare([correct, defect]), [correct, defect]);
    const answers = [correct, defect].map(
      (results) => results.cases.find((c) => c.id === id)?.samples[0]?.turns[0]?.response?.text,
    );
    expect(answers[0]).not.toBe(answers[1]);
    for (const answer of answers) {
      expect(html).toContain(`<pre class="text">${escaped(answer ?? '')}</pre>`);
    }
    expect(html).toContain(`<details class="case" id="case-${id}" open>`);
  });

  it('names the same rows gone, reversed', () => {
    const forward = compare([get('correct'), get('defect')]);
    const backward = compare([get('defect'), get('correct')]);
    const rows = (comparison: typeof forward, from: number, to: number) =>
      comparison.cases
        .flatMap((c) =>
          (c.findings ?? [])
            .filter((row) => (row.failed[from] ?? 0) > 0 && (row.failed[to] ?? 0) === 0)
            .map((row) => `${c.id} ${String(row.turn)} ${row.check}`),
        )
        .toSorted();
    expect(rows(backward, 0, 1)).toEqual(rows(forward, 1, 0));
    expect(rows(backward, 0, 1).length).toBeGreaterThan(0);
  });

  it('shows no change in findings between two runs of the correct shop', () => {
    const comparison = compare([get('correct'), get('again')]);
    expect(comparison.cases.filter((c) => c.findingsDiffer === true).map((c) => c.id)).toEqual([]);
    expect(comparison.cases.filter((c) => c.differs).map((c) => c.id)).toEqual([]);
  });
});
