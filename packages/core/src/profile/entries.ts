// A profile's entries (ADR-0047): its leaves, each named by a JSON Pointer
// (RFC 6901). The analyzer's proposal is compared with a profile entry by
// entry, and a profile's provenance map names its entries by pointer. Pure.

import type { JsonValue } from '../extract/response.ts';

/** One reference token of a pointer, escaped: "~" as "~0", "/" as "~1". */
function escapeToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

function unescapeToken(token: string): string {
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

/** The pointer to a path of keys and indexes: ["ecommerce", "catalog"] → "/ecommerce/catalog". */
export function pointerOf(path: readonly (string | number)[]): string {
  return path.map((part) => `/${escapeToken(String(part))}`).join('');
}

/** The keys and indexes a pointer names, as written: "/a~1b/0" → ["a/b", "0"]. */
export function pointerPath(pointer: string): string[] {
  return pointer === '' ? [] : pointer.slice(1).split('/').map(unescapeToken);
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value a pointer leads to, or undefined when it leads nowhere. */
export function resolvePointer(document: unknown, pointer: string): unknown {
  let at: unknown = document;
  for (const token of pointerPath(pointer)) {
    if (Array.isArray(at)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) return undefined;
      at = at[Number(token)];
    } else if (isObject(at) && Object.hasOwn(at, token)) {
      at = at[token];
    } else {
      return undefined;
    }
  }
  return at;
}

export interface ProfileEntry {
  readonly pointer: string;
  readonly value: JsonValue;
}

function isScalar(value: JsonValue): value is string | number | boolean | null {
  return value === null || typeof value !== 'object';
}

/**
 * The leaves of a document: scalars, lists of scalars (one entry each, compared
 * as sets), and empty objects and lists. A list of objects gives the leaves of
 * each item, by position. A `provenance`, the map at the top or an entry's own
 * such as a capability's, says where entries came from and is no entry.
 */
export function profileEntries(document: JsonValue): ProfileEntry[] {
  const entries: ProfileEntry[] = [];
  const walk = (value: JsonValue, path: (string | number)[]): void => {
    if (isScalar(value)) {
      entries.push({ pointer: pointerOf(path), value });
    } else if (Array.isArray(value)) {
      if (value.every(isScalar)) {
        entries.push({ pointer: pointerOf(path), value });
      } else {
        for (const [index, item] of value.entries()) walk(item, [...path, index]);
      }
    } else {
      const keys = Object.keys(value).filter((key) => key !== 'provenance');
      if (keys.length === 0 && path.length > 0) entries.push({ pointer: pointerOf(path), value });
      for (const key of keys) walk(value[key] ?? null, [...path, key]);
    }
  };
  walk(document, []);
  return entries;
}

/** A list of scalars as a set: its items' JSON, sorted. */
function setKey(list: readonly JsonValue[]): string {
  return JSON.stringify(list.map((item) => JSON.stringify(item)).toSorted());
}

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

/** Equal as entries: a list of scalars is a set. */
function sameEntry(a: JsonValue, b: JsonValue): boolean {
  if (Array.isArray(a) && Array.isArray(b) && a.every(isScalar) && b.every(isScalar)) {
    return setKey(a) === setKey(b);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

const under = (pointer: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => pointer === prefix || pointer.startsWith(`${prefix}/`));

/** The pointers of a profile's provenance map whose entries aren't approved. */
export function unapprovedEntries(
  document: JsonValue,
): { readonly pointer: string; readonly status: 'proposed' | 'rejected' }[] {
  const map = isObject(document) ? document['provenance'] : undefined;
  if (!isObject(map)) return [];
  return Object.entries(map).flatMap(([pointer, provenance]) => {
    const status = isObject(provenance) ? provenance['status'] : undefined;
    return status === 'proposed' || status === 'rejected' ? [{ pointer, status }] : [];
  });
}

export interface ProfileComparison {
  /** The profile has the same value at the pointer. */
  readonly same: readonly ProfileEntry[];
  /** The profile has another value there. */
  readonly different: readonly {
    readonly pointer: string;
    readonly value: JsonValue;
    readonly reference: JsonValue;
  }[];
  /** The profile has nothing there. */
  readonly new: readonly ProfileEntry[];
  /** The profile has an approved entry the proposal lacks. */
  readonly missed: readonly ProfileEntry[];
  /** same ÷ (same + different + new); null with nothing proposed. */
  readonly precision: number | null;
  /** same ÷ (same + different + missed); null with nothing to find. */
  readonly recall: number | null;
}

/**
 * A proposal compared with a profile, entry by entry (ADR-0047). Entries under
 * `exclude`, such as the person's own inputs, are left out of both; so are the
 * profile's entries that aren't approved.
 */
export function compareProfiles(
  proposal: JsonValue,
  reference: JsonValue,
  exclude: readonly string[] = [],
): ProfileComparison {
  const unapproved = unapprovedEntries(reference).map((entry) => entry.pointer);
  const skipped = ['/version', ...exclude];
  const proposed = profileEntries(proposal).filter((entry) => !under(entry.pointer, skipped));
  const known = profileEntries(reference).filter(
    (entry) => !under(entry.pointer, [...skipped, ...unapproved]),
  );
  const byPointer = new Map(known.map((entry) => [entry.pointer, entry.value]));
  const same: ProfileEntry[] = [];
  const different: { pointer: string; value: JsonValue; reference: JsonValue }[] = [];
  const added: ProfileEntry[] = [];
  for (const entry of proposed) {
    const value = byPointer.get(entry.pointer);
    if (value === undefined) added.push(entry);
    else if (sameEntry(entry.value, value)) same.push(entry);
    else different.push({ ...entry, reference: value });
  }
  const proposedPointers = new Set(proposed.map((entry) => entry.pointer));
  const missed = known.filter((entry) => !proposedPointers.has(entry.pointer));
  return {
    same,
    different,
    new: added,
    missed,
    precision: ratio(same.length, same.length + different.length + added.length),
    recall: ratio(same.length, same.length + different.length + missed.length),
  };
}
