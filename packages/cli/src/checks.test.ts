import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_DIMENSIONS, YoklaConfig, type Case } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import { loadCheckModules } from './checks.ts';
import { DOMAIN_PACKS } from './packs.ts';

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-checks-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const NO_IDS_JS = `export default {
  api: 1,
  id: 'no-internal-ids',
  description: 'The answer shows no internal product id.',
  dimension: 'internal-ids',
  policy: 'advisory',
  run(turn) {
    const found = turn.answer.text.match(/\\b[A-Z]{3}-\\d{3}\\b/u);
    return {
      findings: [
        found === null
          ? { verdict: 'pass', message: 'no internal id' }
          : { verdict: 'fail', message: \`shows \${found[0]}\` },
      ],
    };
  },
};
`;

const SHORT_TS = `interface Turn {
  readonly answer: { readonly text: string };
  readonly expect?: { readonly words: number };
}

const check = {
  api: 1,
  id: 'short-answer',
  description: 'The answer has at most this many words.',
  dimension: 'answer-content',
  expect: { type: 'object', required: ['words'], properties: { words: { type: 'integer' } } },
  run(turn: Turn) {
    if (turn.expect === undefined) return { applicable: false, reason: 'no word limit' };
    const words = turn.answer.text.split(/\\s+/u).filter((word) => word !== '').length;
    return { findings: [{ verdict: words <= turn.expect.words ? 'pass' : 'fail', message: \`\${String(words)} words\` }] };
  },
};

export default check;
`;

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const NO_CASES: Case[] = [];

const customCase = (custom: unknown): Case => ({
  id: 'k',
  suite: 'quality',
  language: 'tr',
  tags: [],
  turns: [{ user: 'a', expect: { custom } }],
});

describe('loadCheckModules (ADR-0030)', () => {
  it('loads JavaScript and TypeScript modules relative to the config, with their hashes', async () => {
    const dir = workspace({
      'yokla.config.yaml': 'version: 1\n',
      'checks/no-ids.mjs': NO_IDS_JS,
      'checks/short.ts': SHORT_TS,
    });
    const loaded = await loadCheckModules(
      ['./checks/no-ids.mjs', 'checks/short.ts'],
      join(dir, 'yokla.config.yaml'),
      NO_CASES,
      DOMAIN_PACKS,
    );
    expect(loaded.checks.map((check) => check.id)).toEqual(['no-internal-ids', 'short-answer']);
    expect(loaded.modules).toEqual([
      { id: 'no-internal-ids', module: 'checks/no-ids.mjs', sha256: sha(NO_IDS_JS) },
      { id: 'short-answer', module: 'checks/short.ts', sha256: sha(SHORT_TS) },
    ]);
    expect(loaded.policies).toEqual({ 'internal-ids': 'advisory' });
    expect(
      await loadCheckModules([], join(dir, 'yokla.config.yaml'), NO_CASES, DOMAIN_PACKS),
    ).toEqual({ checks: [], policies: {}, modules: [] });
  });

  it.each([
    ['a missing file', {}, /checks\/x\.mjs: ENOENT/u],
    [
      'a module that does not load',
      { 'checks/x.mjs': 'export default {' },
      /checks\/x\.mjs: the module could not be loaded: /u,
    ],
    [
      'a default export outside the contract',
      { 'checks/x.mjs': 'export default { api: 1, id: "x" };' },
      /checks\/x\.mjs: the default export is not a check by contract version 1\n {2}description: [\s\S]*\n {2}run: run must be a function/u,
    ],
    [
      'no default export',
      { 'checks/x.mjs': 'export const check = 1;' },
      /checks\/x\.mjs: the default export is not a check by contract version 1\n {2}\(the export\): /u,
    ],
  ])('refuses %s, naming the module', async (_name, files, message) => {
    const dir = workspace({ 'yokla.config.yaml': 'version: 1\n', ...files });
    await expect(
      loadCheckModules(['checks/x.mjs'], join(dir, 'yokla.config.yaml'), NO_CASES, DOMAIN_PACKS),
    ).rejects.toThrow(message);
  });

  it('takes each module once in the config, none by default', () => {
    expect(YoklaConfig.parse({ version: 1 }).checks).toEqual([]);
    const twice = YoklaConfig.safeParse({ version: 1, checks: ['a.mjs', 'a.mjs'] });
    expect(JSON.stringify(twice.error?.issues)).toContain('a module is listed twice');
  });

  it('refuses two modules with one id, and a policy for a built-in dimension', async () => {
    const dir = workspace({
      'yokla.config.yaml': 'version: 1\n',
      'a.mjs': NO_IDS_JS,
      'b.mjs': NO_IDS_JS,
      'c.mjs': NO_IDS_JS.replace("'internal-ids'", "'fabrication'"),
    });
    const config = join(dir, 'yokla.config.yaml');
    await expect(
      loadCheckModules(['a.mjs', 'b.mjs'], config, NO_CASES, DOMAIN_PACKS),
    ).rejects.toThrow('b.mjs: the check id "no-internal-ids" is taken by another module');
    // fabrication is the e-commerce pack's own dimension.
    await expect(loadCheckModules(['c.mjs'], config, NO_CASES, DOMAIN_PACKS)).rejects.toThrow(
      `check "no-internal-ids" sets a policy for "fabrication", a dimension of yokla's own checks, which keeps its own`,
    );
  });

  it('checks the values cases give a check against its expect schema', async () => {
    const dir = workspace({ 'yokla.config.yaml': 'version: 1\n', 'short.ts': SHORT_TS });
    const config = join(dir, 'yokla.config.yaml');
    await expect(
      loadCheckModules(
        ['short.ts'],
        config,
        [customCase({ 'short-answer': { words: 'ten' } })],
        DOMAIN_PACKS,
      ),
    ).rejects.toThrow(
      'case "k" turn 1: expect.custom.short-answer: $.words: type, expected integer, got string',
    );
    await expect(
      loadCheckModules([], config, [customCase({ 'short-answer': { words: 10 } })], DOMAIN_PACKS),
    ).rejects.toThrow('case "k" turn 1: expect.custom.short-answer: no loaded check has this id');
  });
});

/** The dimension names written in the non-test sources of these directories. */
function dimensionsIn(...dirs: string[]): Set<string> {
  const names = new Set<string>();
  for (const dir of dirs) {
    const path = new URL(dir, import.meta.url);
    for (const file of readdirSync(path, { recursive: true, encoding: 'utf8' })) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const text = readFileSync(new URL(file, path), 'utf8');
      for (const match of text.matchAll(/dimension: '([a-z-]+)'|const DIMENSION = '([a-z-]+)'/gu)) {
        names.add(match[1] ?? match[2] ?? '');
      }
    }
  }
  return names;
}

describe('the dimensions of the built-in checks (ADR-0030)', () => {
  it('lists every dimension the core checks report, and only those', () => {
    expect(
      [...dimensionsIn('../../core/src/checks/', '../../core/src/customer/')].toSorted(),
    ).toEqual([...CORE_DIMENSIONS].toSorted());
  });

  it('gives every dimension the e-commerce checks report a policy, and no other', () => {
    const pack = DOMAIN_PACKS.find((candidate) => candidate.id === 'ecommerce');
    expect([...dimensionsIn('../../../packs/ecommerce/src/')].toSorted()).toEqual(
      Object.keys(pack?.dimensions ?? {}).toSorted(),
    );
  });
});
