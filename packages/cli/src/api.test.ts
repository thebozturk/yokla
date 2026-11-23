import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  baselineOf,
  CASSETTE_SCHEMA_ID,
  CORE_CHECKS,
  evaluateGate,
  Results,
  RESULTS_SCHEMA_ID,
  YoklaConfig,
} from '@yokla/core';
import { describe, expect, it } from 'vitest';
import {
  compare,
  createAssertion,
  gate,
  loadProject,
  parseRunOptions,
  projectFrom,
  run,
  suiteOptions,
  type RunOptions,
} from './api.ts';
import { loadConfig, LoadError } from './load.ts';
import { DOMAIN_PACKS, LANGUAGE_PACKS } from './packs.ts';
import { version } from './version.ts';

const PROFILE = {
  version: 1,
  target: {
    name: 't',
    adapter: 'http',
    request: { url: 'http://127.0.0.1:1/chat', body: { message: '{{message}}' } },
    response: { text: '$.answer' },
  },
  languages: ['tr'],
  domain: 'ecommerce',
};

const PROFILE_YAML = `version: 1
target:
  name: t
  adapter: http
  request: { url: 'http://127.0.0.1:1/chat', body: { message: '{{message}}' } }
  response: { text: $.answer }
languages: [tr]
domain: ecommerce
`;

const CASE = {
  id: 'a',
  suite: 'quality',
  language: 'tr',
  tags: ['greeting'],
  turns: [{ user: 'merhaba' }],
};

const caseFile = (id: string) =>
  `version: 1\ncases:\n  - id: ${id}\n    suite: quality\n    language: tr\n    turns: [{ user: merhaba }]\n`;

/** A directory with a profile, a case directory and, when given, a configuration. */
function workspace(config?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-api-'));
  writeFileSync(join(dir, 'yokla.profile.yaml'), PROFILE_YAML);
  mkdirSync(join(dir, 'cases'));
  writeFileSync(join(dir, 'cases', 'a.yaml'), caseFile('a'));
  if (config !== undefined) writeFileSync(join(dir, 'yokla.config.yaml'), config);
  return dir;
}

/** A run of one case with this status. */
function results(id: string, status: 'pass' | 'fail'): Results {
  return Results.parse({
    schema: RESULTS_SCHEMA_ID,
    yokla: { version: '0.0.0-test' },
    run: {
      id,
      startedAt: '2026-11-23T12:00:00.000Z',
      finishedAt: '2026-11-23T12:00:01.000Z',
      durationMs: 1000,
      profile: { target: 't', sha256: 'a'.repeat(64) },
      environment: { node: 'v24.0.0', platform: 'darwin', arch: 'arm64' },
      correlation: 'serial',
      partial: false,
    },
    cases: [
      {
        id: 'a',
        suite: 'quality',
        language: 'tr',
        status,
        unstable: false,
        definitionSha256: 'd'.repeat(64),
        dimensions: [],
        samples: [],
      },
    ],
    checks: [],
    summary: { cases: 1, statuses: { [status]: 1 } },
  });
}

/** A callback the options keep as given. */
function onTransformPlan(): void {
  // Nothing to do: only its identity counts.
}

const CASSETTE = {
  schema: CASSETTE_SCHEMA_ID,
  profileSha256: 'a'.repeat(64),
  recordedAt: '2026-11-23T12:00:00.000Z',
  calls: [],
};

/** The message of the LoadError parseRunOptions throws for these options. */
function problem(options: unknown): string {
  try {
    parseRunOptions(options);
  } catch (error) {
    if (error instanceof LoadError) return error.message;
    throw error;
  }
  throw new Error('no LoadError');
}

const CHECK_MODULE = `export default {
  api: 1,
  id: 'mine',
  description: 'Always passes.',
  dimension: 'mine',
  policy: 'majority-of-n',
  run() {
    return { findings: [{ verdict: 'pass', message: 'fine' }] };
  },
};
`;

/** The message of the LoadError a load rejects with. */
async function loadProblem(loading: Promise<unknown>): Promise<string> {
  try {
    await loading;
  } catch (error) {
    if (error instanceof LoadError) return error.message;
    throw error;
  }
  throw new Error('no LoadError');
}

describe('loadProject (ADR-0093)', () => {
  it('reads the cases next to the profile, wherever cwd is', async () => {
    const dir = workspace();
    const elsewhere = mkdtempSync(join(tmpdir(), 'yokla-api-cwd-'));
    const project = await loadProject({ profile: join(dir, 'yokla.profile.yaml'), cwd: elsewhere });
    expect(project.cases.map((c) => c.id)).toEqual(['a']);
    expect(project.casePaths).toEqual([join(dir, 'cases')]);
  });

  it('loads the check modules a configuration in cwd names, relative to it', async () => {
    const dir = workspace('version: 1\nchecks: [./mine.mjs]\n');
    writeFileSync(join(dir, 'mine.mjs'), CHECK_MODULE);
    for (const config of [undefined, 'yokla.config.yaml']) {
      const project = await loadProject({ cwd: dir, config });
      expect(project.userChecks.modules.map((m) => m.module)).toEqual(['mine.mjs']);
      const options = suiteOptions(project, parseRunOptions({}), keep);
      expect(options.checks?.map((c) => c.id)).toEqual([...CORE_CHECKS.map((c) => c.id), 'mine']);
      expect(options.checkModules).toEqual(project.userChecks.modules);
      expect(options.policies).toEqual({ mine: 'majority-of-n' });
    }
  });

  it('shows a broken file’s path relative to cwd', async () => {
    const dir = workspace();
    writeFileSync(join(dir, 'cases', 'a.yaml'), 'version: 1\ncases: [{ id: a }]\n');
    await expect(loadProject({ cwd: dir })).rejects.toThrow(/^cases\/a\.yaml:/u);
    writeFileSync(join(dir, 'odd.yaml'), 'version: 2\n');
    expect(() => loadConfig('odd.yaml', dir)).toThrow(/^odd\.yaml:/u);
    writeFileSync(join(dir, 'fine.yaml'), 'version: 1\ngate: { maxFailures: 4 }\n');
    expect(loadConfig('fine.yaml', dir).gate.maxFailures).toBe(4);
  });

  it('finds a run’s files as yokla run does, relative to cwd', async () => {
    const dir = workspace('version: 1\ngate: { maxFailures: 1 }\n');
    const project = await loadProject({ cwd: dir });
    expect(project.cases.map((c) => c.id)).toEqual(['a']);
    expect(project.dir).toBe(dir);
    expect(project.casePaths).toEqual([join(dir, 'cases')]);
    expect(project.config?.gate.maxFailures).toBe(1);
    expect(project.profileSha256).toBe(createHash('sha256').update(PROFILE_YAML).digest('hex'));
  });

  it('reads relative paths from cwd, and no configuration when none is there', async () => {
    const dir = workspace();
    writeFileSync(join(dir, 'other.yaml'), caseFile('b'));
    const project = await loadProject({ cwd: dir, cases: ['other.yaml'] });
    expect(project.cases.map((c) => c.id)).toEqual(['b']);
    expect(project.config).toBeUndefined();
    writeFileSync(join(dir, 'lenient.yaml'), 'version: 1\ngate: { maxFailures: 2 }\n');
    const named = await loadProject({ cwd: dir, config: 'lenient.yaml' });
    expect(named.config?.gate.maxFailures).toBe(2);
  });

  it('takes no more case files than its options name', async () => {
    const dir = workspace();
    writeFileSync(join(dir, 'extra.yaml'), caseFile('extra'));
    const options = { cwd: dir, alsoCases: [join(dir, 'extra.yaml')] };
    expect((await loadProject(options)).cases.map((c) => c.id)).toEqual(['a']);
  });

  it('refuses a profile entry no person approved (ADR-0047)', async () => {
    const dir = workspace();
    writeFileSync(
      join(dir, 'yokla.profile.yaml'),
      `${PROFILE_YAML}provenance:\n  /target/name: { source: probe, evidence: probe 1, status: proposed }\n`,
    );
    await expect(loadProject({ cwd: dir })).rejects.toThrow(/1 entry is not approved/u);
  });
});

describe('projectFrom (ADR-0093)', () => {
  it('takes a profile, cases and a configuration as objects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-api-objects-'));
    const project = await projectFrom({
      profile: PROFILE,
      cases: [CASE],
      config: { version: 1, gate: { maxFailures: 3 } },
      dir,
    });
    expect(project.cases.map((c) => c.id)).toEqual(['a']);
    expect(project.casePaths).toEqual([]);
    expect(project.dir).toBe(dir);
    expect(project.config?.gate.maxFailures).toBe(3);
    expect(project.profileSha256).toBe(
      createHash('sha256').update(JSON.stringify(PROFILE)).digest('hex'),
    );
    expect((await projectFrom({ profile: PROFILE, cases: [CASE], dir })).config).toBeUndefined();
  });

  it('reads the schema files the objects name, relative to dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-api-objects-'));
    writeFileSync(join(dir, 'answer.json'), '{"type": "object"}');
    const project = await projectFrom({
      profile: {
        ...PROFILE,
        target: {
          ...PROFILE.target,
          response: { text: '$.answer', schema: { schemaFile: 'answer.json' } },
        },
      },
      cases: [
        {
          ...CASE,
          turns: [{ user: 'merhaba', expect: { schema: [{ schemaFile: 'answer.json' }] } }],
        },
      ],
      dir,
    });
    expect(project.profile.target.response.schema).toEqual({ at: '$', schema: { type: 'object' } });
    expect(project.cases[0]?.turns[0]?.expect?.schema).toEqual([
      { at: '$', schema: { type: 'object' } },
    ]);
  });

  it('loads the check modules the configuration names, relative to dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-api-objects-'));
    writeFileSync(join(dir, 'mine.mjs'), CHECK_MODULE);
    const project = await projectFrom({
      profile: PROFILE,
      cases: [CASE],
      config: { version: 1, checks: ['./mine.mjs'] },
      dir,
    });
    expect(project.userChecks.modules.map((m) => m.module)).toEqual(['mine.mjs']);
  });

  it('names what doesn’t validate, and where', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-api-objects-'));
    const many = await loadProblem(
      projectFrom({ profile: { ...PROFILE, languages: 'tr', domain: 3 }, cases: [CASE], dir }),
    );
    expect(many).toMatch(/\n {2}languages: .*\n {2}domain: /su);
    await expect(projectFrom({ profile: { version: 1 }, cases: [CASE], dir })).rejects.toThrow(
      /^profile: invalid\n {2}target: /u,
    );
    await expect(
      projectFrom({ profile: PROFILE, cases: [{ ...CASE, turns: [] }], dir }),
    ).rejects.toThrow(/^cases: invalid\n {2}cases\.0\.turns/u);
    await expect(
      projectFrom({ profile: PROFILE, cases: [CASE], config: { version: 2 }, dir }),
    ).rejects.toThrow(/^config: invalid\n {2}version/u);
    await expect(
      projectFrom({
        profile: {
          ...PROFILE,
          provenance: {
            '/target/name': { source: 'probe', evidence: 'probe 1', status: 'proposed' },
          },
        },
        cases: [CASE],
        dir,
      }),
    ).rejects.toThrow(/^profile: 1 entry is not approved/u);
  });
});

describe('run options (ADR-0093)', () => {
  it('gives each attacker bound the default of its flag', () => {
    expect(parseRunOptions({ attacker: { strategy: 'escalation' } }).attacker).toEqual({
      strategy: 'escalation',
      limit: 5,
    });
    expect(parseRunOptions({ attacker: { strategy: 'best-of-n' } }).attacker).toEqual({
      strategy: 'best-of-n',
      limit: 4,
    });
    expect(parseRunOptions({ attacker: { strategy: 'iterative' } }).attacker).toEqual({
      strategy: 'iterative',
      limit: 4,
    });
    expect(parseRunOptions({ attacker: { strategy: 'tree' } }).attacker).toEqual({
      strategy: 'tree',
      branches: 3,
      depth: 2,
    });
    expect(parseRunOptions({ attacker: { strategy: 'translate' } }).attacker).toEqual({
      strategy: 'translate',
    });
    expect(
      parseRunOptions({ attacker: { strategy: 'tree', branches: 5, depth: 3 } }).attacker,
    ).toEqual({ strategy: 'tree', branches: 5, depth: 3 });
  });

  it('takes what the flags take', () => {
    const options: RunOptions = {
      tags: ['greeting'],
      samples: 3,
      stopEarly: true,
      concurrency: 2,
      targetUrl: 'http://127.0.0.1:1/chat',
      proxyUrl: 'http://127.0.0.1:2',
      maxCostUsd: 0.5,
      record: true,
      swaps: [{ upstream: 'fake', asked: 'big', model: 'mini' }],
      reversals: [{ tool: 'search', at: '$.results' }],
      transforms: ['typos'],
      strategy: ['base64', 'roleplay'],
      attacker: { strategy: 'best-of-n', limit: 2 },
      fresh: { customer: true, attacker: true, judge: true },
      env: { TOKEN: 'x', NOTHING: undefined },
    };
    expect(parseRunOptions(options)).toEqual(options);
    expect(parseRunOptions({ onTransformPlan }).onTransformPlan).toBe(onTransformPlan);
    expect(
      parseRunOptions({ replay: { cassette: CASSETTE, sha256: 'b'.repeat(64), loose: true } })
        .replay?.loose,
    ).toBe(true);
  });

  it('refuses what the flags refuse', () => {
    expect(problem({ samples: 0 })).toMatch(/^run options: invalid\n {2}samples: /u);
    expect(problem({ concurrency: 1.5 })).toMatch(/concurrency: /u);
    expect(problem({ maxCostUsd: 0 })).toMatch(/maxCostUsd: /u);
    expect(problem({ attacker: { strategy: 'best-of-n', limit: 0 } })).toMatch(
      /attacker\.limit: /u,
    );
    expect(problem({ attacker: { strategy: 'tree', branches: 6 } })).toMatch(
      /attacker\.branches: /u,
    );
    expect(problem({ attacker: { strategy: 'tree', depth: 4 } })).toMatch(/attacker\.depth: /u);
    expect(problem({ attacker: { strategy: 'swarm' } })).toMatch(/attacker\.strategy: /u);
    expect(problem({ strategy: ['base64', 'hex', 'rot13'] })).toMatch(/strategy: /u);
    expect(problem({ strategy: [] })).toMatch(/strategy: /u);
    expect(problem({ transforms: ['shouting'] })).toMatch(/transforms\.0: /u);
    expect(problem({ replay: { cassette: { calls: [] }, sha256: 'b' } })).toMatch(
      /replay\.cassette/u,
    );
  });

  it('refuses a key it doesn’t know, and options that don’t go together', () => {
    expect(problem({ nope: 1 })).toMatch(/nope/u);
    expect(problem({ attacker: { strategy: 'tree', attempts: 2 } })).toMatch(/attempts/u);
    expect(problem({ attacker: { strategy: 'escalation', attempts: 2 } })).toMatch(/attempts/u);
    expect(problem({ record: true, replay: { cassette: CASSETTE, sha256: 'b'.repeat(64) } })).toBe(
      'run options: invalid\n  record: record and replay go one at a time',
    );
    expect(problem({ fresh: { attacker: true } })).toBe(
      'run options: invalid\n  fresh.attacker: needs attacker',
    );
    expect(() => parseRunOptions({ record: true })).not.toThrow();
    expect(() => parseRunOptions({ fresh: { customer: true, judge: true } })).not.toThrow();
  });

  it('checks the options and the tags before anything reaches the target', async () => {
    const dir = workspace();
    const project = await loadProject({ cwd: dir });
    await expect(run(project, { samples: 0 })).rejects.toThrow(LoadError);
    await expect(run(project, { tags: ['nothing'] })).rejects.toThrow(
      'no case has the tag "nothing"',
    );
  });
});

describe('gate and compare (ADR-0093)', () => {
  it('judge a run as the gate does, with the configuration’s thresholds and a baseline', () => {
    const failed = results('r1', 'fail');
    expect(gate(failed)).toEqual(evaluateGate(failed));
    expect(gate(failed).verdict).toBe('broken');
    const config = YoklaConfig.parse({ version: 1, gate: { maxFailures: 1 } });
    expect(gate(failed, { config }).verdict).toBe('pass');
    // The case passed in the baseline, so failing now breaks the gate (ADR-0011).
    const baseline = baselineOf(results('r0', 'pass'));
    expect(gate(failed, { config, baseline }).verdict).toBe('broken');
  });

  it('set two runs or more side by side, each gated', () => {
    const comparison = compare([results('r1', 'pass'), results('r2', 'fail')]);
    expect(comparison.runs.map((r) => [r.id, r.gate.verdict])).toEqual([
      ['r1', 'pass'],
      ['r2', 'broken'],
    ]);
    expect(comparison.cases[0]?.differs).toBe(true);
    expect(() => compare([results('r1', 'pass')])).toThrow('a comparison takes two runs or more');
  });
});

/** A recording's receiver the runner's options keep as given. */
function keep(): void {
  // Nothing to do: only its identity counts.
}

/** A project of two cases, one tagged, from objects, with a configuration when given. */
async function twoCases(config?: unknown) {
  return projectFrom({
    profile: PROFILE,
    cases: [CASE, { ...CASE, id: 'b', tags: [] }],
    ...(config === undefined ? {} : { config }),
    dir: mkdtempSync(join(tmpdir(), 'yokla-api-suite-')),
  });
}

describe('what run gives the runner (ADR-0093)', () => {
  it('passes each option on as yokla run passes its flag', async () => {
    const project = await twoCases();
    const given = parseRunOptions({
      tags: ['greeting'],
      samples: 3,
      stopEarly: true,
      concurrency: 2,
      targetUrl: 'http://127.0.0.1:1/chat',
      proxyUrl: 'http://127.0.0.1:2',
      maxCostUsd: 0.5,
      record: true,
      swaps: [{ upstream: 'fake', asked: 'big', model: 'mini' }],
      reversals: [{ tool: 'search', at: '$.results' }],
      transforms: ['typos'],
      strategy: ['base64', 'roleplay'],
      attacker: { strategy: 'best-of-n', limit: 2 },
      fresh: { customer: true, attacker: true, judge: true },
      env: { TOKEN: 'x' },
      onTransformPlan,
    });
    const options = suiteOptions(project, given, keep);
    expect(options.cases.map((c) => c.id)).toEqual(['a']);
    expect(options).toMatchObject({
      samples: 3,
      stopEarly: true,
      concurrency: 2,
      targetUrl: 'http://127.0.0.1:1/chat',
      proxyUrl: 'http://127.0.0.1:2',
      maxCostUsd: 0.5,
      cassette: { record: true },
      swaps: [{ upstream: 'fake', asked: 'big', model: 'mini' }],
      reversals: [{ tool: 'search', at: '$.results' }],
      transforms: ['typos'],
      strategy: ['base64', 'roleplay'],
      attacker: { strategy: 'best-of-n', limit: 2, fresh: true },
      freshCustomer: true,
      freshJudge: true,
      env: { TOKEN: 'x' },
    });
    expect(options.onCassette).toBe(keep);
    expect(options.onTransformPlan).toBe(onTransformPlan);
  });

  it('replays a cassette, loose only when asked', async () => {
    const project = await twoCases();
    const replay = { cassette: CASSETTE, sha256: 'b'.repeat(64) };
    const loose = suiteOptions(
      project,
      parseRunOptions({ replay: { ...replay, loose: true } }),
      keep,
    );
    expect(loose.cassette).toEqual({ replay: CASSETTE, sha256: 'b'.repeat(64), loose: true });
    expect(loose.onCassette).toBeUndefined();
    const strict = suiteOptions(project, parseRunOptions({ replay }), keep);
    expect(strict.cassette).toEqual({ replay: CASSETTE, sha256: 'b'.repeat(64) });
  });

  it('passes nothing the options leave out, empty or false', async () => {
    const project = await twoCases();
    const options = suiteOptions(
      project,
      parseRunOptions({
        stopEarly: false,
        record: false,
        swaps: [],
        reversals: [],
        transforms: [],
        attacker: { strategy: 'translate' },
        fresh: { customer: false, attacker: false, judge: false },
      }),
      keep,
    );
    expect(options.cases.map((c) => c.id)).toEqual(['a', 'b']);
    expect(options.attacker).toEqual({ strategy: 'translate' });
    expect(options.env).toBe(process.env);
    for (const key of [
      'samples',
      'stopEarly',
      'concurrency',
      'targetUrl',
      'proxyUrl',
      'maxCostUsd',
      'cassette',
      'onCassette',
      'swaps',
      'reversals',
      'transforms',
      'strategy',
      'onTransformPlan',
      'freshCustomer',
      'freshJudge',
    ]) {
      expect(Object.hasOwn(options, key), key).toBe(false);
    }
    expect(Object.hasOwn(suiteOptions(project, parseRunOptions({}), keep), 'attacker')).toBe(false);
  });

  it('gives the runner the project, yokla’s packs and checks, and the configuration’s models', async () => {
    const plain = suiteOptions(await twoCases(), parseRunOptions({}), keep);
    expect(plain.profile.target.name).toBe('t');
    expect(plain.yoklaVersion).toBe(version());
    expect(plain.checks).toEqual(CORE_CHECKS);
    expect(plain.packs).toBe(DOMAIN_PACKS);
    expect(plain.languages).toBe(LANGUAGE_PACKS);
    expect(plain.checkModules).toEqual([]);
    expect(plain.policies).toEqual({});
    expect(Object.hasOwn(plain, 'prices')).toBe(false);
    expect(Object.hasOwn(plain, 'models')).toBe(false);
    expect(Object.hasOwn(plain, 'judge')).toBe(false);
    const project = await twoCases({ version: 1 });
    const configured = suiteOptions(project, parseRunOptions({}), keep);
    expect(configured.profileSha256).toBe(project.profileSha256);
    expect(configured.profileDir).toBe(project.dir);
    expect(configured.prices).toBe(project.config?.prices);
    expect(configured.models).toBe(project.config?.models);
    expect(configured.judge).toBe(project.config?.judge);
  });
});

/** A project whose cases the assertion judges: one turn, two turns, and one with no expectation. */
function judgedProject() {
  return projectFrom({
    profile: PROFILE,
    cases: [
      { ...CASE, turns: [{ user: 'merhaba', expect: { answer: { contains: ['merhaba'] } } }] },
      {
        ...CASE,
        id: 'two',
        turns: [
          { user: 'merhaba' },
          { user: 'sonra?', expect: { answer: { contains: ['sonra'] } } },
        ],
      },
      { ...CASE, id: 'none', turns: [{ user: 'merhaba' }] },
      { ...CASE, id: 'timed', turns: [{ user: 'merhaba', expect: { deadlineMs: 1000 } }] },
    ],
    dir: mkdtempSync(join(tmpdir(), 'yokla-api-assert-')),
  });
}

describe('the assertion function (ADR-0096)', () => {
  it('passes an answer the case’s checks pass, and fails one they fail', async () => {
    const assert = createAssertion(await judgedProject());
    expect(await assert('Merhaba! Nasıl yardımcı olabilirim?', { case: 'a' })).toEqual({
      pass: true,
      score: 1,
      reason: '1 of 1 findings passed',
      verdict: 'pass',
    });
    const failed = await assert('Hoşça kal.', { case: 'a' });
    expect(failed).toMatchObject({ pass: false, score: 0, verdict: 'fail' });
    expect(failed.reason).toMatch(/^answer-text \(answer-content\): /u);
  });

  it('reads the target’s body with the profile, as a run does, or takes the text and evidence', async () => {
    const assert = createAssertion(await judgedProject());
    expect((await assert({ body: { answer: 'Merhaba!' } }, { case: 'a' })).verdict).toBe('pass');
    expect((await assert({ text: 'Merhaba!', evidence: {} }, { case: 'a' })).verdict).toBe('pass');
    const unread = await assert({ body: { reply: 'Merhaba!' } }, { case: 'a' });
    expect(unread).toMatchObject({ pass: false, score: 0, verdict: 'unmeasured' });
    expect(unread.reason).toMatch(/^unmeasured: answer text not found at /u);
    // The body is what the target said: a text beside it doesn't count.
    expect(
      (await assert({ body: { answer: 'Merhaba!' }, text: 'Güle güle' }, { case: 'a' })).verdict,
    ).toBe('pass');
  });

  it('never passes an answer no check applied to', async () => {
    const assert = createAssertion(await judgedProject());
    expect(await assert('Merhaba!', { case: 'none' })).toEqual({
      pass: false,
      score: 0,
      reason: 'unmeasured: no check applied to the answer',
      verdict: 'unmeasured',
    });
  });

  it('judges a deadline only on the latency it is given', async () => {
    const assert = createAssertion(await judgedProject());
    expect(await assert('Merhaba!', { case: 'timed' })).toEqual({
      pass: false,
      score: 0,
      reason: "unmeasured: answered-within-deadline (deadline): the answer's latency was not given",
      verdict: 'unmeasured',
    });
    expect((await assert({ text: 'Merhaba!', latencyMs: 400 }, { case: 'timed' })).verdict).toBe(
      'pass',
    );
    expect((await assert({ text: 'Merhaba!', latencyMs: 4000 }, { case: 'timed' })).verdict).toBe(
      'fail',
    );
  });

  it('judges the last turn by default, a named turn, with the earlier answers before it', async () => {
    const assert = createAssertion(await judgedProject());
    expect((await assert('ve sonra şunu', { case: 'two' })).verdict).toBe('pass');
    expect((await assert('başka', { case: 'two', earlier: ['merhaba'] })).verdict).toBe('fail');
    expect((await assert('merhaba', { case: 'two', turn: 0 })).verdict).toBe('unmeasured');
  });

  it('refuses a case or a turn it can’t judge', async () => {
    const assert = createAssertion(await judgedProject());
    await expect(assert('x', { case: 'nope' })).rejects.toThrow('no case "nope" in the project');
    await expect(assert('x', { case: 'two', turn: 2 })).rejects.toThrow(
      'case "two" has turns 0 to 1, not 2',
    );
    await expect(assert('x', { case: 'two', turn: -1 })).rejects.toThrow(
      'case "two" has turns 0 to 1, not -1',
    );
    await expect(assert('x', { case: 'two', turn: 0, earlier: ['y'] })).rejects.toThrow(
      '1 earlier answers for turn 0, which has 0 before it',
    );
  });
});

/** A profile that maps the route, the products and a clarifying route. */
const MAPPED = {
  ...PROFILE,
  target: {
    ...PROFILE.target,
    response: {
      text: '$.answer',
      route: '$.route',
      evidence: {
        products: { items: '$.products[*]', fields: { id: 'id', name: 'name', price: 'price' } },
      },
      clarification: { routes: ['clarify'] },
    },
  },
};

const TENT = { id: 'T1', name: 'Kubbe Çadır', price: 100 };

/** A project on MAPPED: a case that wants products, one with a contract, and a follow-up. */
function mappedProject() {
  return projectFrom({
    profile: MAPPED,
    cases: [
      {
        ...CASE,
        id: 'shown',
        turns: [{ user: 'çadır', expect: { evidence: { products: { min: 1 } } } }],
      },
      {
        ...CASE,
        id: 'contract',
        turns: [
          {
            user: 'çadır',
            expect: { schema: [{ schema: { type: 'object', required: ['answer'] } }] },
          },
        ],
      },
      {
        ...CASE,
        id: 'priced',
        turns: [{ user: 'çadır' }, { user: 'fiyatı?', expect: { answer: { notEmpty: true } } }],
      },
      {
        ...CASE,
        id: 'faulty',
        turns: [
          {
            user: 'çadır',
            faults: [{ fault: { kind: 'status', status: 500 } }],
            expect: { answer: { notEmpty: true } },
          },
        ],
      },
    ],
    dir: mkdtempSync(join(tmpdir(), 'yokla-api-mapped-')),
  });
}

describe('the assertion reads an answer as a run does (ADR-0096)', () => {
  it('reads the evidence from the body, or as the results hold it, and the route', async () => {
    const assert = createAssertion(await mappedProject());
    expect(
      (await assert({ body: { answer: 'Çadır', products: [TENT] } }, { case: 'shown' })).verdict,
    ).toBe('pass');
    expect(
      (
        await assert(
          { text: 'Çadır', evidence: { products: [TENT, ['not an item']] } },
          { case: 'shown' },
        )
      ).verdict,
    ).toBe('pass');
    expect(
      (await assert({ text: 'Çadır', evidence: { products: [] } }, { case: 'shown' })).verdict,
    ).toBe('fail');
    // Only an object is an item: an array in a collection isn't counted.
    expect(
      (
        await assert(
          { text: 'Çadır', evidence: { products: [['not an item']] } },
          { case: 'shown' },
        )
      ).verdict,
    ).toBe('fail');
    // A clarifying question isn't held to the products it would show.
    const asked = await assert(
      { body: { answer: 'Hangisi?', route: 'clarify', products: [] } },
      { case: 'shown' },
    );
    expect(asked.verdict).toBe('unmeasured');
  });

  it('validates the body against the turn’s contract', async () => {
    const assert = createAssertion(await mappedProject());
    expect((await assert({ body: { answer: 'Çadır' } }, { case: 'contract' })).verdict).toBe(
      'pass',
    );
    expect((await assert('Çadır', { case: 'contract' })).verdict).toBe('unmeasured');
  });

  it('judges an answer with a status it doesn’t allow by the checks that need no answer', async () => {
    const assert = createAssertion(await mappedProject());
    expect(
      (await assert({ body: { answer: 'Çadır' }, status: 200 }, { case: 'priced', turn: 1 }))
        .verdict,
    ).toBe('pass');
    expect(
      (await assert({ body: { answer: 'Çadır' }, status: 500 }, { case: 'priced', turn: 1 }))
        .verdict,
    ).toBe('unmeasured');
  });

  it('grounds a price in the products an earlier answer showed', async () => {
    const assert = createAssertion(await mappedProject());
    const earlier = [{ body: { answer: 'Kubbe Çadır var.', products: [TENT] } }];
    const followUp = {
      body: {
        answer: 'Kubbe Çadır 100 TL, Plaj Çadırı 200 TL.',
        products: [{ id: 'T2', name: 'Plaj Çadırı', price: 200 }],
      },
    };
    expect((await assert(followUp, { case: 'priced', turn: 1, earlier })).verdict).toBe('pass');
    expect((await assert(followUp, { case: 'priced', turn: 1 })).verdict).toBe('fail');
  });

  it('refuses a case the run would refuse, as one whose faults need the model proxy', async () => {
    const assert = createAssertion(await mappedProject());
    await expect(assert('Çadır', { case: 'faulty' })).rejects.toThrow(
      'case "faulty" injects faults, which needs a modelProxy in the profile',
    );
  });
});
