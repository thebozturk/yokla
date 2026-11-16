import { describe, expect, it } from 'vitest';
import {
  argumentShape,
  type Coverage,
  EMPTY_COVERAGE,
  newCoverage,
  unionCoverage,
} from './coverage.ts';

const coverage = (part: Partial<Coverage>): Coverage => ({ ...EMPTY_COVERAGE, ...part });

describe('argumentShape (ADR-0044)', () => {
  it('names a tool with the sorted keys of its arguments, nested keys as dotted paths', () => {
    expect(argumentShape('search', '{"q":"tent","filters":{"size":"M","priceMax":5}}')).toBe(
      'search{filters.priceMax,filters.size,q}',
    );
    expect(argumentShape('search', '{"filters":{},"tags":["a"],"n":null}')).toBe(
      'search{filters,n,tags}',
    );
    expect(argumentShape('search', '{"a":{"b":{"c":1}}}')).toBe('search{a.b.c}');
  });

  it('gives arguments that are no JSON object no keys', () => {
    expect(argumentShape('t', '{}')).toBe('t{}');
    expect(argumentShape('t', '[1,2]')).toBe('t{}');
    expect(argumentShape('t', '"text"')).toBe('t{}');
    expect(argumentShape('t', 'not json')).toBe('t{}');
    expect(argumentShape('t', undefined)).toBe('t{}');
  });
});

describe('coverage sets', () => {
  it('unites two coverages, sorted and without repeats', () => {
    expect(
      unionCoverage(
        coverage({ routes: ['b', 'a'], tools: ['x'], offered: ['x'] }),
        coverage({ routes: ['a', 'c'], shapes: ['x{}'], faultStates: ['a/status'] }),
      ),
    ).toEqual({
      routes: ['a', 'b', 'c'],
      tools: ['x'],
      shapes: ['x{}'],
      faultStates: ['a/status'],
      offered: ['x'],
    });
  });

  it('labels what is new, and never counts an offered tool as reached', () => {
    const seen = coverage({ routes: ['a'], tools: ['x'], shapes: ['x{}'] });
    const next = coverage({
      routes: ['a', 'b'],
      tools: ['x', 'y'],
      shapes: ['x{}', 'y{q}'],
      faultStates: ['a/timeout'],
      offered: ['z'],
    });
    expect(newCoverage(seen, next)).toEqual(['route:b', 'tool:y', 'shape:y{q}', 'fault:a/timeout']);
    expect(newCoverage(next, seen)).toEqual([]);
  });
});
