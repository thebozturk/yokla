import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESULTS_SCHEMA_ID, type Results } from '@yokla/core';
import { ProxyControl } from '@yokla/runtime';
import { describe, expect, it } from 'vitest';
import { LoadError, loadCases, loadProfile } from './load.ts';
import { baselineCommand } from './commands/baseline.ts';
import { gateCommand } from './commands/gate.ts';
import { planCommand } from './commands/plan.ts';
import { proxyCommand } from './commands/proxy.ts';
import { printSummary } from './commands/run.ts';
import { main } from './main.ts';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    out,
    err,
  };
}

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-cli-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const PROFILE = `version: 1
target:
  name: t
  adapter: http
  request: { url: 'http://127.0.0.1:1/chat', body: { message: '{{message}}' } }
  response: { text: $.answer }
languages: [tr]
domain: ecommerce
`;

const CASES = `version: 1
cases:
  - id: a
    suite: quality
    language: tr
    turns: [{ user: merhaba }]
`;

describe('loading', () => {
  it('loads a profile and hashes the file', () => {
    const dir = workspace({ 'yokla.profile.yaml': PROFILE });
    const loaded = loadProfile(join(dir, 'yokla.profile.yaml'));
    expect(loaded.profile.target.name).toBe('t');
    expect(loaded.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(loaded.dir).toBe(dir);
  });

  it('reports profile problems with their position', () => {
    const dir = workspace({ 'p.yaml': PROFILE.replace('adapter: http', 'adaptr: http') });
    expect(() => loadProfile(join(dir, 'p.yaml'))).toThrow(
      /p\.yaml:4:3: target\.adaptr: unknown key/u,
    );
  });

  it('loads every case file of a directory, in name order', () => {
    const dir = workspace({
      'cases/b.yaml': CASES.replace('id: a', 'id: b'),
      'cases/a.yml': CASES,
      'cases/notes.txt': 'ignored',
    });
    expect(loadCases([join(dir, 'cases')]).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('collects the problems of every case file', () => {
    const dir = workspace({
      'cases/a.yaml': CASES.replace('suite: quality', 'suite: vibes'),
      'cases/b.yaml': CASES.replace('language: tr', 'language: de'),
    });
    expect(() => loadCases([join(dir, 'cases')])).toThrow(
      /a\.yaml:4:12: cases\[0\]\.suite[\s\S]*b\.yaml:5:15: cases\[0\]\.language/u,
    );
  });

  it('fails clearly on a missing path or an empty directory', () => {
    expect(() => loadCases(['/no/such/yokla/cases'])).toThrow(LoadError);
    const dir = workspace({ 'cases/readme.md': '' });
    expect(() => loadCases([join(dir, 'cases')])).toThrow(/no case files/u);
  });
});

describe('yokla', () => {
  it('prints its version and help', async () => {
    const version = capture();
    expect(await main(['--version'], version.io)).toBe(0);
    expect(version.out[0]).toMatch(/^\d+\.\d+\.\d+/u);
    const help = capture();
    expect(await main([], help.io)).toBe(0);
    expect(help.out[0]).toMatch(/Usage:/u);
  });

  it('prints a JSON Schema', async () => {
    const { io, out } = capture();
    expect(await main(['schema', 'results'], io)).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ title: 'yokla results v1' });
  });

  it('exits with 2 on an unknown command, option or schema', async () => {
    expect(await main(['launch'], capture().io)).toBe(2);
    expect(await main(['run', '--frobnicate'], capture().io)).toBe(2);
    expect(await main(['schema', 'nope'], capture().io)).toBe(2);
  });

  it('exits with 2 and reports a configuration problem before any request', async () => {
    const dir = workspace({
      'yokla.profile.yaml': PROFILE.replace("'{{message}}'", "'{{mesage}}'"),
      'cases/a.yaml': CASES,
    });
    const { io, err } = capture();
    expect(await main(['run', '--profile', join(dir, 'yokla.profile.yaml')], io)).toBe(2);
    expect(err.join('\n')).toMatch(/unknown placeholder \{\{mesage\}\}/u);
  });

  it('rejects a cost cap that is not a positive amount', async () => {
    const dir = workspace({ 'yokla.profile.yaml': PROFILE, 'cases/a.yaml': CASES });
    for (const cap of [['--max-cost', '0'], ['--max-cost=-1'], ['--max-cost', 'cheap']]) {
      const { io, err } = capture();
      expect(await main(['run', '--profile', join(dir, 'yokla.profile.yaml'), ...cap], io)).toBe(2);
      expect(err[0]).toBe('--max-cost must be a positive number of USD');
    }
  });

  it('rejects a non-numeric sample count', async () => {
    const dir = workspace({ 'yokla.profile.yaml': PROFILE, 'cases/a.yaml': CASES });
    const { io, err } = capture();
    expect(
      await main(['run', '--profile', join(dir, 'yokla.profile.yaml'), '--samples', 'many'], io),
    ).toBe(2);
    expect(err[0]).toBe('--samples must be a positive integer');
  });
});

describe('the run summary', () => {
  const results: Results = {
    schema: RESULTS_SCHEMA_ID,
    yokla: { version: '0.0.0-test' },
    run: {
      id: 'r',
      startedAt: '2026-11-10T12:00:00.000Z',
      finishedAt: '2026-11-10T12:00:01.000Z',
      durationMs: 1000,
      profile: { target: 't', sha256: 'a'.repeat(64) },
      environment: { node: 'v24.0.0', platform: 'darwin', arch: 'arm64' },
      correlation: 'none',
      partial: false,
    },
    cases: [],
    checks: [],
    summary: { cases: 0, statuses: {} },
  };

  it('states what the target logs observed, and run issues', () => {
    const { io, out, err } = capture();
    printSummary(
      {
        ...results,
        run: {
          ...results.run,
          observation: {
            source: 'target-logs',
            correlation: 'request-id',
            lines: 3,
            matched: 2,
            unmatched: 1,
            totals: { costUsd: 0.0012345678, modelCalls: 3 },
            missing: { costUsd: 1, route: 2 },
          },
          issues: ['something broke'],
        },
      },
      'runs/r.json',
      io,
    );
    expect(out).toContain(
      'target logs: 2 of 3 turns matched; costUsd 0.001235 (no value on 1 turn), modelCalls 3, route no value on 2 turns',
    );
    expect(err).toEqual(['  run: something broke']);
  });

  it('says nothing about logs when none are configured', () => {
    const { io, out, err } = capture();
    printSummary(results, 'runs/r.json', io);
    expect(out.join('\n')).not.toMatch(/target logs/u);
    expect(err).toEqual([]);
  });
});

describe('yokla report', () => {
  const valid = {
    schema: RESULTS_SCHEMA_ID,
    yokla: { version: '0.0.0-test' },
    run: {
      id: 'r',
      startedAt: '2026-11-10T12:00:00.000Z',
      finishedAt: '2026-11-10T12:00:01.000Z',
      durationMs: 1000,
      profile: { target: 't', sha256: 'a'.repeat(64) },
      environment: { node: 'v24.0.0', platform: 'darwin', arch: 'arm64' },
      correlation: 'none',
      partial: false,
    },
    cases: [
      {
        id: 'a',
        suite: 'quality',
        language: 'tr',
        status: 'unmeasured',
        unstable: false,
        dimensions: [],
        samples: [{ index: 0, cache: 'cold', turns: [{ user: 'u', checks: [] }] }],
      },
    ],
    checks: [],
    summary: { cases: 1, statuses: { unmeasured: 1 } },
  };

  it('prints the summary of a results file and writes JUnit XML', async () => {
    const dir = workspace({ 'run.json': JSON.stringify(valid) });
    const junit = join(dir, 'reports', 'junit.xml');
    const { io, out, err } = capture();
    expect(await main(['report', '--results', join(dir, 'run.json'), '--junit', junit], io)).toBe(
      0,
    );
    expect(out).toEqual([
      '1 cases: unmeasured 1',
      '  unmeasured  a  no check applied to any turn',
      `junit: ${junit}`,
    ]);
    expect(err).toEqual([]);
    expect(readFileSync(junit, 'utf8')).toContain(
      '<testsuites name="yokla" tests="1" failures="0" errors="0" skipped="1"',
    );
  });

  it('refuses a file it cannot read, another schema or invalid results', async () => {
    const dir = workspace({
      'broken.json': '{',
      'other.json': JSON.stringify({ ...valid, schema: 'yokla.results/v2' }),
      'bad.json': JSON.stringify({ ...valid, summary: { cases: 'one' } }),
    });
    const report = async (file: string) => {
      const { io, err } = capture();
      return {
        code: await main(['report', '--results', join(dir, file)], io),
        err: err.join('\n'),
      };
    };
    const expectRefusal = async (file: string, message: RegExp) => {
      const outcome = await report(file);
      expect(outcome.code).toBe(2);
      expect(outcome.err).toMatch(message);
    };
    await expectRefusal('missing.json', /ENOENT/u);
    await expectRefusal('broken.json', /JSON/u);
    await expectRefusal(
      'other.json',
      /not a yokla\.results\/v1 file \(schema: "yokla\.results\/v2"\)/u,
    );
    await expectRefusal('bad.json', /invalid results\n  summary\.cases: /u);
  });

  it('needs --results and rejects unknown options', async () => {
    expect(await main(['report'], capture().io)).toBe(2);
    expect(await main(['report', '--nope'], capture().io)).toBe(2);
    const { io, out } = capture();
    expect(await main(['report', '--help'], io)).toBe(0);
    expect(out[0]).toMatch(/^Usage: yokla report/u);
  });
});

function resultsJson(statuses: Record<string, string>, suite = 'factual'): string {
  const ids = Object.keys(statuses);
  const counts: Record<string, number> = {};
  for (const status of Object.values(statuses)) counts[status] = (counts[status] ?? 0) + 1;
  return JSON.stringify({
    schema: RESULTS_SCHEMA_ID,
    yokla: { version: '0.0.0-test' },
    run: {
      id: 'r',
      startedAt: '2026-11-10T12:00:00.000Z',
      finishedAt: '2026-11-10T12:00:01.000Z',
      durationMs: 1000,
      profile: { target: 't', sha256: 'a'.repeat(64) },
      environment: { node: 'v24.0.0', platform: 'darwin', arch: 'arm64' },
      correlation: 'none',
      partial: false,
    },
    cases: ids.map((id) => ({
      id,
      suite,
      language: 'tr',
      status: statuses[id],
      unstable: false,
      dimensions: [],
      samples: [],
    })),
    checks: [],
    summary: { cases: ids.length, statuses: counts },
  });
}

describe('yokla gate', () => {
  const dir = workspace({
    'pass.json': resultsJson({ a: 'pass', b: 'pass' }),
    'fail.json': resultsJson({ a: 'pass', b: 'fail' }),
    'error.json': resultsJson({ a: 'error', b: 'fail' }),
    'lenient.yaml': 'version: 1\ngate: { maxFailures: 1 }\n',
    'broken.yaml': 'version: 1\ngate:\n  maxFailure: 1\n',
  });
  // The workspace is the working directory, so no yokla.config.yaml or
  // yokla.baseline.json from elsewhere is picked up.
  const gate = (...args: string[]) => {
    const { io, out, err } = capture();
    const code = gateCommand(
      args.map((a) => (a.startsWith('--') ? a : join(dir, a))),
      io,
      dir,
    );
    return Promise.resolve({ code, out, err });
  };

  it('passes with 0 and says when the default thresholds apply', async () => {
    expect(await gate('--results', 'pass.json')).toEqual({
      code: 0,
      out: [
        'gate: passed',
        '  notice: no yokla.config.yaml; the defaults apply: no failing or unmeasured case',
      ],
      err: [],
    });
  });

  it('breaks with 1, unless the config allows the failure', async () => {
    expect(await gate('--results', 'fail.json')).toMatchObject({
      code: 1,
      out: ['gate: broken', '  factual: 1 failing case, 0 allowed: b', expect.any(String)],
    });
    expect(await gate('--results', 'fail.json', '--config', 'lenient.yaml')).toEqual({
      code: 0,
      out: ['gate: passed'],
      err: [],
    });
  });

  it('breaks on a regression against the baseline, whatever the config allows', async () => {
    const outcome = await gate(
      '--results',
      'fail.json',
      '--config',
      'lenient.yaml',
      '--baseline',
      'pass.json',
    );
    expect(outcome).toEqual({
      code: 1,
      out: ['gate: broken', '  b passed in the baseline and is now fail'],
      err: [],
    });
  });

  it('reads yokla.config.yaml from the working directory by default', () => {
    const project = workspace({
      'yokla.config.yaml': 'version: 1\ngate: { maxFailures: 1 }\n',
      'fail.json': resultsJson({ a: 'pass', b: 'fail' }),
    });
    const { io, out } = capture();
    expect(gateCommand(['--results', join(project, 'fail.json')], io, project)).toBe(0);
    expect(out).toEqual(['gate: passed']);
  });

  it("exits with 2 when the run can't be judged or a file can't be read", async () => {
    expect(await gate('--results', 'error.json')).toMatchObject({
      code: 2,
      out: [
        "gate: the run can't be judged",
        '  factual: 1 failing case, 0 allowed: b',
        expect.any(String),
      ],
      err: ['  1 error case: a'],
    });
    const badConfig = await gate('--results', 'pass.json', '--config', 'broken.yaml');
    expect(badConfig.code).toBe(2);
    expect(badConfig.err.join('\n')).toMatch(/broken\.yaml:3:3: gate\.maxFailure: /u);
    expect((await gate('--results', 'pass.json', '--baseline', 'missing.json')).code).toBe(2);
    expect((await gate('--results', 'pass.json', '--config', 'missing.yaml')).code).toBe(2);
    expect((await gate()).code).toBe(2);
    expect((await gate('--frobnicate')).code).toBe(2);
  });
});

describe('yokla baseline', () => {
  it('writes a first baseline, then shows what changed, and the gate reads it by default', () => {
    const project = workspace({
      'one.json': resultsJson({ a: 'pass', b: 'fail' }),
      'two.json': resultsJson({ a: 'fail', b: 'pass', c: 'pass' }),
    });
    const accept = (file: string, ...extra: string[]) => {
      const { io, out, err } = capture();
      const code = baselineCommand(['--results', join(project, file), ...extra], io, project);
      return { code, out, err };
    };
    const path = join(project, 'yokla.baseline.json');
    expect(accept('one.json')).toEqual({
      code: 0,
      out: ['new baseline: 2 cases', `baseline: ${path}`],
      err: [],
    });
    const written: unknown = JSON.parse(readFileSync(path, 'utf8'));
    expect(written).toMatchObject({
      schema: 'yokla.baseline/v1',
      cases: [
        { id: 'a', status: 'pass' },
        { id: 'b', status: 'fail' },
      ],
    });

    expect(accept('two.json', '--dry-run')).toEqual({
      code: 0,
      out: ['~ a: pass → fail', '~ b: fail → pass', '+ c (pass)', 'dry run: nothing written'],
      err: [],
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(written);

    const { io, out } = capture();
    expect(gateCommand(['--results', join(project, 'two.json')], io, project)).toBe(1);
    expect(out).toContain('  a passed in the baseline and is now fail');
    expect(out).toContain(`  notice: compared with the baseline in ${path}`);
  });

  it("refuses a run the gate can't judge, and a broken baseline file", () => {
    const project = workspace({
      'error.json': resultsJson({ a: 'error' }),
      'ok.json': resultsJson({ a: 'pass' }),
      'yokla.baseline.json': '{"schema":"yokla.baseline/v1"}',
    });
    const { io, err } = capture();
    expect(baselineCommand(['--results', join(project, 'error.json')], io, project)).toBe(2);
    expect(err).toEqual(["can't accept a run the gate can't judge:", '  1 error case: a']);
    const broken = capture();
    expect(baselineCommand(['--results', join(project, 'ok.json')], broken.io, project)).toBe(2);
    expect(broken.err.join('\n')).toMatch(/yokla\.baseline\.json: invalid baseline/u);
    expect(baselineCommand([], capture().io, project)).toBe(2);
  });
});

const PROXY_PROFILE = `${PROFILE}modelProxy:
  upstreams:
    - { id: openai, kind: openai-compatible, upstream: 'https://api.openai.com/v1', appBaseUrlEnv: OPENAI_BASE_URL }
`;

/** Starts \`yokla proxy\` and waits for its address. */
async function startedProxy(args: string[]) {
  const { io, out, err } = capture();
  const stop = new AbortController();
  const done = proxyCommand(args, io, stop.signal);
  for (let i = 0; i < 100 && !out.some((line) => line.startsWith('proxy: http')); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const url = /http:\/\/127\.0\.0\.1:\d+/u.exec(out[0] ?? '')?.[0] ?? '';
  return { url, out, err, stop, done };
}

/** Runs \`yokla proxy\` with a signal that is already aborted, for refusals. */
async function refusedProxy(...args: string[]) {
  const { io, err } = capture();
  return { code: await proxyCommand(args, io, AbortSignal.abort()), err: err.join('\n') };
}

describe('yokla proxy', () => {
  it('listens on 127.0.0.1, answers its control endpoint and stops on request', async () => {
    const dir = workspace({ 'yokla.profile.yaml': PROXY_PROFILE });
    const proxy = await startedProxy(['--profile', join(dir, 'yokla.profile.yaml'), '--port', '0']);
    expect(proxy.out).toEqual([
      `proxy: ${proxy.url} (127.0.0.1 only)`,
      `  ${proxy.url}/openai → https://api.openai.com/v1 (OPENAI_BASE_URL=${proxy.url}/openai)`,
    ]);
    const control = new ProxyControl(proxy.url);
    expect(await control.health()).toEqual({ ok: true, upstreams: ['openai'], recording: false });
    const { id } = await control.open();
    expect(await control.close(id)).toEqual([]);
    proxy.stop.abort();
    expect(await proxy.done).toBe(0);
    expect(proxy.out.at(-1)).toBe('proxy: stopped');
  });

  it('refuses a profile without modelProxy, a bad port, and a port in use', async () => {
    const dir = workspace({ 'plain.yaml': PROFILE, 'yokla.profile.yaml': PROXY_PROFILE });
    const profile = join(dir, 'yokla.profile.yaml');
    const plain = await refusedProxy('--profile', join(dir, 'plain.yaml'));
    expect(plain.code).toBe(2);
    expect(plain.err).toMatch(/has no modelProxy section/u);
    expect(await refusedProxy('--profile', profile, '--port', '70000')).toEqual({
      code: 2,
      err: '--port must be an integer from 0 to 65535',
    });
    const first = await startedProxy(['--profile', profile, '--port', '0']);
    const inUse = await refusedProxy('--profile', profile, '--port', new URL(first.url).port);
    expect(inUse.code).toBe(2);
    expect(inUse.err).toMatch(/can't listen on 127\.0\.0\.1:\d+/u);
    first.stop.abort();
    await first.done;
  });
});

/** A calibration results file with one answered turn of this cost. */
const calibrationJson = (costUsd: number | null, proxy = true) =>
  JSON.stringify({
    schema: RESULTS_SCHEMA_ID,
    yokla: { version: '0.1.0' },
    run: {
      id: 'cal',
      startedAt: '2026-11-10T12:00:00.000Z',
      finishedAt: '2026-11-10T12:00:01.000Z',
      durationMs: 1000,
      profile: { target: 't', sha256: 'a'.repeat(64) },
      environment: { node: 'v24.0.0', platform: 'darwin', arch: 'arm64' },
      correlation: 'serial',
      partial: false,
      ...(proxy
        ? {
            proxy: {
              correlation: 'serial',
              records: 1,
              attributed: 1,
              unattributed: 0,
              totals: {},
              missing: {},
            },
          }
        : {}),
    },
    cases: [
      {
        id: 'other',
        suite: 'quality',
        language: 'tr',
        status: 'pass',
        unstable: false,
        dimensions: [],
        samples: [
          {
            index: 0,
            cache: 'cold',
            turns: [
              {
                user: 'u',
                checks: [],
                response: { status: 200, latencyMs: 5, evidence: {} },
                proxy: { correlation: 'serial', calls: [], costUsd },
              },
            ],
          },
        ],
      },
    ],
    checks: [],
    summary: { cases: 1, statuses: { pass: 1 } },
  });

describe('yokla plan', () => {
  it('estimates from the calibration with the configured upper bound factor', () => {
    const dir = workspace({
      'cases/a.yaml': CASES,
      'cal.json': calibrationJson(0.002),
      'yokla.config.yaml': 'version: 1\nplan: { upperBoundFactor: 3 }\n',
    });
    const { io, out, err } = capture();
    const code = planCommand(
      ['--cases', join(dir, 'cases'), '--calibration', join(dir, 'cal.json'), '--samples', '5'],
      io,
      dir,
    );
    expect({ code, err }).toEqual({ code: 0, err: [] });
    expect(out).toEqual([
      'plan: 1 cases, 5 turns with their samples',
      '  0 of 1 cases priced from their own calibration; the rest at the mean, 0.002 USD a turn',
      '  estimate: 0.01 USD; upper bound: 0.03 USD (3x)',
      "  yokla's own model calls: none",
    ]);
  });

  it('gives no figure without a calibration or with an unusable one', () => {
    const dir = workspace({
      'cases/a.yaml': CASES,
      'unpriced.json': calibrationJson(null),
      'plain.json': calibrationJson(0.001, false),
    });
    const run = (...args: string[]) => {
      const { io, err } = capture();
      return { code: planCommand(args, io, dir), err: err.join('\n') };
    };
    expect(run('--cases', join(dir, 'cases')).code).toBe(2);
    const unpriced = run(
      '--cases',
      join(dir, 'cases'),
      '--calibration',
      join(dir, 'unpriced.json'),
    );
    expect(unpriced.code).toBe(2);
    expect(unpriced.err).toMatch(/^plan: no estimate: 1 calibrated turn of 1 has no cost/u);
    expect(
      run('--cases', join(dir, 'cases'), '--calibration', join(dir, 'plain.json')).err,
    ).toMatch(/no model proxy data/u);
    expect(
      run('--cases', join(dir, 'cases'), '--calibration', join(dir, 'missing.json')).code,
    ).toBe(2);
  });
});
