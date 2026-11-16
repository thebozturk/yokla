// What a run reached (ADR-0044): the routes the target answered on, the tools
// the model asked for, each tool's argument shape (the sorted keys of its
// arguments), and the routes answered under each fault kind. A search keeps a
// candidate that reaches something no run before it did. Names only: no
// argument value is kept.

import { z } from 'zod';

export const Coverage = z.object({
  routes: z.array(z.string()),
  tools: z.array(z.string()),
  /** A tool with the sorted keys of its arguments, such as `search_products{priceMax,productType}`. */
  shapes: z.array(z.string()),
  /** A route answered under a fault kind, such as `fallback/status`. */
  faultStates: z.array(z.string()),
  /** Tools the model was offered, asked for or not. */
  offered: z.array(z.string()),
});
export type Coverage = z.output<typeof Coverage>;

/** What a run reached, in its results (ADR-0044). */
export const RunCoverage = Coverage.extend({
  /** What yokla explore reached beyond the written cases, as labelled keys such as `route:cart`. */
  added: z.array(z.string()).optional(),
});
export type RunCoverage = z.output<typeof RunCoverage>;

export const EMPTY_COVERAGE: Coverage = {
  routes: [],
  tools: [],
  shapes: [],
  faultStates: [],
  offered: [],
};

/** The keys of an object at every depth, as dotted paths to its leaves; an array is a leaf. */
function leafPaths(value: unknown, prefix: string): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [prefix];
  const keys = Object.keys(value);
  if (keys.length === 0) return [prefix];
  return keys.flatMap((key) =>
    leafPaths(Reflect.get(value, key), prefix === '' ? key : `${prefix}.${key}`),
  );
}

/**
 * A tool's argument shape: the tool with the sorted keys of its JSON
 * arguments, a nested key as a dotted path as the `tools` expectation names
 * it (ADR-0025), such as `search_products{filters.priceMax,productType}`.
 */
export function argumentShape(tool: string, args: string | undefined): string {
  // Arguments that are no JSON object are a leaf at the root: no keys.
  let keys: string[] = [];
  try {
    keys = leafPaths(JSON.parse(args ?? ''), '').toSorted();
  } catch {
    // Arguments that aren't JSON have no keys either.
  }
  return `${tool}{${keys.join(',')}}`;
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].toSorted();

const added = (label: string, before: readonly string[], after: readonly string[]): string[] =>
  after.filter((value) => !before.includes(value)).map((value) => `${label}:${value}`);

/** Both coverages together. */
export function unionCoverage(a: Coverage, b: Coverage): Coverage {
  return {
    routes: sorted([...a.routes, ...b.routes]),
    tools: sorted([...a.tools, ...b.tools]),
    shapes: sorted([...a.shapes, ...b.shapes]),
    faultStates: sorted([...a.faultStates, ...b.faultStates]),
    offered: sorted([...a.offered, ...b.offered]),
  };
}

/**
 * What `next` reached that `seen` didn't, as labelled keys such as
 * `route:cart` or `tool:add_to_cart`. Offered tools aren't reached: the model
 * only saw them.
 */
export function newCoverage(seen: Coverage, next: Coverage): string[] {
  return [
    ...added('route', seen.routes, next.routes),
    ...added('tool', seen.tools, next.tools),
    ...added('shape', seen.shapes, next.shapes),
    ...added('fault', seen.faultStates, next.faultStates),
  ];
}
