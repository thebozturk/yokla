// Export (ADR-0096, E4 of ADR-0092): the demo-shop's cases run against the
// correct shop and one with fabricated-price, through the library API. Every
// turn's recorded answer, given to the assertion function with the earlier
// turns', gets the run's verdict and failing findings. Each single-turn
// case's message, sent to the shop by this test as another tool would, gets
// the run's verdict from its body. The run's exported case rows and result
// rows parse with their schemas. Under the egress guard.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Results } from '@yokla/core';
import { CaseRow, ResultRow } from '@yokla/interop-rows';
import { HttpClient } from '@yokla/runtime';
import { installNetworkGuard, type NetworkGuard } from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  caseRows,
  createAssertion,
  loadProject,
  resultRows,
  run,
  type AssertionAnswer,
} from './api.ts';
import type { Project } from './prepare.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const DEFECTS = ['none', 'fabricated-price'] as const;

const children: ChildProcess[] = [];
const shopPorts = new Set<number>();
let guard: NetworkGuard | undefined;
let project: Project | undefined;
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

function loaded(): Project {
  if (project === undefined) throw new Error('the project did not load');
  return project;
}

function ran(defect: string): Results {
  const results = runs.get(defect);
  if (results === undefined) throw new Error(`no run against ${defect}`);
  return results;
}

/** A turn's failing findings, as the assertion's reason names them. */
function failingText(
  checks: Results['cases'][number]['samples'][number]['turns'][number]['checks'],
) {
  return checks
    .flatMap((check) =>
      check.findings
        .filter((finding) => finding.verdict === 'fail')
        .map((finding) => `${check.check} (${finding.dimension}): ${finding.message}`),
    )
    .join('; ');
}

beforeAll(async () => {
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && shopPorts.has(port),
  );
  project = await loadProject({
    profile: join(DEMO, 'yokla.profile.yaml'),
    config: join(DEMO, 'yokla.config.yaml'),
    cases: [join(DEMO, 'cases')],
  });
  const started = await Promise.all(DEFECTS.map((defect) => startShop(defect)));
  await Promise.all(
    DEFECTS.map(async (defect, index) => {
      const url = `${started[index] ?? ''}/v1/chat`;
      urls.set(defect, url);
      const { results } = await run(loaded(), { targetUrl: url });
      runs.set(defect, results);
    }),
  );
}, 240_000);

afterAll(() => {
  guard?.uninstall();
  // Stop exactly the processes these tests started, by their handles.
  for (const child of children) child.kill();
});

describe('export on the demo-shop (ADR-0096)', () => {
  it.each(DEFECTS)(
    'gives every turn of the run against %s the run’s verdict and failing findings',
    async (defect) => {
      const assert = createAssertion(loaded());
      const results = ran(defect);
      const rows = resultRows(results);
      const got: string[] = [];
      const want: string[] = [];
      for (const c of results.cases) {
        for (const sample of c.samples) {
          const earlier: AssertionAnswer[] = [];
          for (const [index, turn] of sample.turns.entries()) {
            const { response } = turn;
            if (response?.text === undefined || turn.error !== undefined) break;
            const answer = {
              text: response.text,
              evidence: response.evidence,
              status: response.status,
              latencyMs: response.latencyMs,
            };
            const result = await assert(answer, { case: c.id, turn: index, earlier: [...earlier] });
            const row = rows.find(
              (one) => one.case === c.id && one.sample === sample.index && one.turn === index,
            );
            const where = `${c.id} ${String(sample.index)}/${String(index)}`;
            got.push(
              `${where}: ${result.verdict}${result.verdict === 'fail' ? ` ${result.reason}` : ''}`,
            );
            want.push(
              `${where}: ${row?.verdict ?? '?'}${row?.verdict === 'fail' ? ` ${failingText(turn.checks)}` : ''}`,
            );
            earlier.push(answer);
          }
        }
      }
      expect(got).toEqual(want);
      expect(got.length).toBeGreaterThan(results.cases.length);
      expect(got.some((line) => line.includes(': fail '))).toBe(defect === 'fabricated-price');
    },
  );

  it.each(DEFECTS)(
    'judges the body of each single-turn case’s answer from %s, as another tool would get it',
    async (defect) => {
      const { target } = loaded().profile;
      if (target.adapter !== 'http') throw new Error('the demo-shop is an HTTP target');
      const url = urls.get(defect) ?? '';
      // Paced, and patient with a 429, as the profile says the shop wants.
      const client = new HttpClient({
        allowedOrigins: [new URL(url).origin],
        timeoutMs: target.request.timeoutMs,
        limits: target.limits,
        retryAfter: target.limits?.retryAfter,
      });
      const assert = createAssertion(loaded());
      const rows = resultRows(ran(defect));
      const single = loaded().cases.filter(
        (c) => c.turns.length === 1 && c.customer === undefined && c.turns[0]?.faults === undefined,
      );
      expect(single.length).toBeGreaterThan(3);
      const got: string[] = [];
      const want: string[] = [];
      for (const c of single) {
        const sent = await client.send({
          url,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: c.turns[0]?.user, sessionId: randomUUID() }),
        });
        const result = await assert(
          { body: sent.json, status: sent.status, latencyMs: sent.latencyMs },
          { case: c.id },
        );
        const row = rows.find((one) => one.case === c.id && one.sample === 0 && one.turn === 0);
        got.push(`${c.id}: ${result.verdict}`);
        want.push(`${c.id}: ${row?.verdict ?? '?'}`);
      }
      expect(got).toEqual(want);
    },
    // The shop's limits pace the requests, and a 429 waits out its Retry-After.
    180_000,
  );

  it('exports case rows and result rows that parse with their schemas', () => {
    const { rows, skipped } = caseRows(loaded().cases);
    expect(rows.length + skipped.length).toBe(loaded().cases.length);
    for (const row of rows) expect(CaseRow.safeParse(row).success, row.id).toBe(true);
    const results = ran('fabricated-price');
    const resultRowsOf = resultRows(results);
    const turns = results.cases.reduce(
      (total, c) => total + c.samples.reduce((sum, sample) => sum + sample.turns.length, 0),
      0,
    );
    expect(resultRowsOf).toHaveLength(turns);
    for (const row of resultRowsOf) expect(ResultRow.safeParse(row).success, row.case).toBe(true);
  });
});
