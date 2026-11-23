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
