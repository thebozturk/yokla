import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCases } from '../load.ts';
import { generateCommand } from './generate.ts';

const DEMO = new URL('../../../../examples/demo-shop/', import.meta.url).pathname;

function io() {
  const lines: string[] = [];
  return {
    lines,
    out: (line: string) => lines.push(line),
    err: (line: string) => lines.push(line),
  };
}

/** A copy of the demo-shop's profile and data. */
function shop(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-generate-'));
  cpSync(join(DEMO, 'yokla.profile.yaml'), join(dir, 'yokla.profile.yaml'));
  cpSync(join(DEMO, 'data'), join(dir, 'data'), { recursive: true });
  return dir;
}

describe('yokla generate (ADR-0055)', () => {
  it('writes proposed cases from the catalog, counts them, and never overwrites without --force', () => {
    const dir = shop();
    const output = io();
    expect(generateCommand(['--absent', 'en:hammock'], output, dir), output.lines.join('\n')).toBe(
      0,
    );
    const file = join(dir, 'cases', 'generated.yaml');
    const text = readFileSync(file, 'utf8');
    expect(output.lines).toContain(`generated 29 proposed cases: ${file}`);
    expect(output.lines).toContain('  lookup: 2 tr, 2 en');
    expect(output.lines).toContain('  absent-type: 1 en');
    const cases = loadCases([file]);
    expect(cases.every((c) => c.provenance?.source === 'generator')).toBe(true);
    expect(cases.every((c) => c.provenance?.status === 'proposed')).toBe(true);

    const again = io();
    expect(generateCommand([], again, dir)).toBe(2);
    expect(again.lines.join('\n')).toContain('exists: --force overwrites it');
    expect(generateCommand(['--absent', 'en:hammock', '--force'], io(), dir)).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('writes where --out says, and as many of each kind as --per-kind', () => {
    const dir = shop();
    const output = io();
    expect(generateCommand(['--out', 'mine.yaml', '--per-kind', '1'], output, dir)).toBe(0);
    expect(existsSync(join(dir, 'mine.yaml'))).toBe(true);
    expect(output.lines).toContain('  lookup: 1 tr, 1 en');
    expect(output.lines).toContain('  none: absent-type (tr): no --absent word was given');
  });

  it.each([
    [['--per-kind', '0'], '--per-kind must be a positive integer'],
    [
      ['--absent', 'hammock'],
      '--absent hammock: write it as <language>:<words>, such as en:hammock',
    ],
    [['--bogus'], "Unknown option '--bogus'"],
  ])('refuses %j', (args, message) => {
    const output = io();
    expect(generateCommand(args, output, shop())).toBe(2);
    expect(output.lines.join('\n')).toContain(message);
  });

  it('asks for each --absent word once, and writes nothing from an empty catalog', () => {
    const dir = shop();
    const output = io();
    expect(
      generateCommand(['--absent', 'en:kayak,kayak', '--absent', 'en:kayak'], output, dir),
    ).toBe(0);
    expect(output.lines).toContain('  absent-type: 1 en');
    writeFileSync(join(dir, 'data', 'catalog.jsonl'), '');
    const empty = io();
    expect(generateCommand(['--force'], empty, dir)).toBe(2);
    expect(empty.lines).toContain('no case was generated: nothing written');
  });

  it('refuses a profile whose pack has no data to generate from', () => {
    const dir = shop();
    const profile = join(dir, 'yokla.profile.yaml');
    const text = readFileSync(profile, 'utf8');
    const start = text.indexOf('  catalog:\n');
    const end = text.indexOf('  # Types are category paths');
    writeFileSync(profile, text.slice(0, start) + text.slice(end));
    const output = io();
    expect(generateCommand([], output, dir)).toBe(2);
    expect(output.lines).toContain(
      'the "ecommerce" domain pack generates no case from this profile\'s data',
    );
  });
});

describe('yokla generate --redteam (ADR-0080)', () => {
  it('writes the attacks to cases/redteam.yaml, and the extraction once the profile has a canary', () => {
    const dir = shop();
    const output = io();
    const args = ['--redteam', '--competitor', 'Rivalmart', '--competitor', ' Rivalmart '];
    expect(generateCommand(args, output, dir), output.lines.join('\n')).toBe(0);
    const file = join(dir, 'cases', 'redteam.yaml');
    expect(readFileSync(file, 'utf8')).toMatch(/^# Written by yokla generate --redteam/u);
    expect(output.lines).toContain('  injection: 2 tr, 2 en');
    expect(output.lines).toContain('  offer: 2 tr, 2 en');
    expect(output.lines).toContain('  commitment: 2 tr, 2 en');
    expect(output.lines).toContain('  competitor: 2 tr, 2 en');
    expect(output.lines).toContain(
      '  none: extraction (tr): the profile has no canary (modelProxy.inspect.canary) to find in an answer',
    );
    const cases = loadCases([file]);
    expect(cases.every((c) => c.suite === 'redteam')).toBe(true);
    // Each competitor once, trimmed.
    const competitor = cases.find((c) => c.id.startsWith('competitor-'));
    expect(competitor?.turns[0]?.expect).toMatchObject({ answer: { notContains: ['Rivalmart'] } });

    const profile = join(dir, 'yokla.profile.yaml');
    writeFileSync(
      profile,
      `${readFileSync(profile, 'utf8')}\nmodelProxy:\n  port: 1\n  upstreams: [{ id: m, kind: openai-compatible, upstream: 'http://127.0.0.1:1' }]\n  inspect: { canary: CANARY-12345 }\n`,
    );
    const withCanary = io();
    expect(generateCommand(['--redteam', '--force'], withCanary, dir)).toBe(0);
    expect(withCanary.lines).toContain('  extraction: 2 tr, 2 en');
    expect(withCanary.lines).toContain('  none: competitor (tr): no --competitor was given');

    // cost-abuse's budget comes from --output-tokens (ADR-0082).
    expect(generateCommand(['--redteam', '--force', '--output-tokens', '900'], io(), dir)).toBe(0);
    const abuse = loadCases([file]).find((c) => c.id.startsWith('cost-abuse-'));
    expect(abuse?.turns[0]?.expect).toMatchObject({ budget: { outputTokens: 900 } });
  });

  it.each([
    [
      ['--redteam', '--absent', 'en:hammock'],
      '--absent is for the data kinds; --redteam writes attacks',
    ],
    [['--competitor', 'Rivalmart'], '--competitor goes with --redteam'],
    [['--output-tokens', '900'], '--output-tokens goes with --redteam'],
    [['--redteam', '--output-tokens', '0'], '--output-tokens must be a positive integer'],
    [['--redteam', '--output-tokens', 'many'], '--output-tokens must be a positive integer'],
  ])('refuses %j', (args, message) => {
    const output = io();
    expect(generateCommand(args, output, shop())).toBe(2);
    expect(output.lines).toContain(message);
  });
});
