import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The GitHub Action (ADR-0094): its default yokla version is the release's
// own, every action it uses is pinned to a commit, and no input or output is
// written into a script, where it could inject a command.

interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
}

interface Action {
  readonly inputs: Readonly<Record<string, { readonly default?: string }>>;
  readonly runs: { readonly using: string; readonly steps: readonly Step[] };
}

function isAction(value: unknown): value is Action {
  return typeof value === 'object' && value !== null && 'inputs' in value && 'runs' in value;
}

const parsed: unknown = parse(readFileSync(new URL('../action.yml', import.meta.url), 'utf8'));
if (!isAction(parsed)) throw new Error('action.yml has no inputs or runs');
const action = parsed;

const cli: unknown = JSON.parse(
  readFileSync(new URL('../packages/cli/package.json', import.meta.url), 'utf8'),
);

describe('the GitHub Action (ADR-0094)', () => {
  it('runs the version of yokla it is released with, by default', () => {
    expect(cli).toMatchObject({ version: action.inputs['version']?.default });
  });

  it('is a composite action, and pins every action it uses to a commit', () => {
    expect(action.runs.using).toBe('composite');
    const uses = action.runs.steps.flatMap((step) => (step.uses === undefined ? [] : [step.uses]));
    expect(uses.length).toBeGreaterThan(0);
    for (const used of uses) expect(used).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/u);
  });

  it('writes no expression into a script: inputs reach the shell through the environment', () => {
    const scripts = action.runs.steps.flatMap((step) => (step.run === undefined ? [] : [step.run]));
    expect(scripts.length).toBeGreaterThan(2);
    for (const script of scripts) expect(script).not.toContain('${{');
  });

  it('reads its exit codes itself, though GitHub runs bash with -e', () => {
    const yokla = action.runs.steps.filter((step) => step.run?.includes('"${yokla[@]}"'));
    expect(yokla.map((step) => step.name)).toEqual(['Run the cases', 'Gate the run']);
    for (const step of yokla) expect(step.run).toContain('set -u +e\n');
  });
});
