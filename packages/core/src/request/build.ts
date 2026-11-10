// Builds the HTTP request for one turn from the profile's request template.
// Pure: the runtime supplies the environment, ids and carried values.
//
// Placeholders: {{message}}, {{session}}, {{requestId}}, {{carry.NAME}},
// {{env.NAME}}. A string that is only a placeholder keeps the value's type;
// if that value doesn't exist yet (a carried value on the first turn), the
// field or header is left out. Inside a longer string a missing value is an
// error.

import { toJson, type JsonValue } from '../extract/response.ts';
import type { CaseTurn } from '../schema/cases.ts';
import type { ProfileTarget } from '../schema/profile.ts';

export interface TemplateValues {
  readonly message: string;
  /** undefined when the session mode is `none`. */
  readonly session: string | undefined;
  /** undefined when the profile doesn't send request ids. */
  readonly requestId: string | undefined;
  readonly carry: Readonly<Record<string, JsonValue>>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface BuiltRequest {
  readonly url: string;
  readonly method: string;
  /** Header names are lower-case. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

export class TemplateError extends Error {
  override readonly name = 'TemplateError';
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/gu;
const WHOLE = /^\{\{\s*([A-Za-z_][\w.]*)\s*\}\}$/u;
const OMIT = Symbol('omit');
type Rendered = JsonValue | typeof OMIT;

type Lookup = { readonly found: true; readonly value: JsonValue } | { readonly found: false };
const MISSING: Lookup = { found: false };

function lookup(name: string, values: TemplateValues): Lookup {
  if (name === 'message') return { found: true, value: values.message };
  if (name === 'session')
    return values.session === undefined ? MISSING : { found: true, value: values.session };
  if (name === 'requestId') {
    return values.requestId === undefined ? MISSING : { found: true, value: values.requestId };
  }
  if (name.startsWith('carry.')) {
    const value = values.carry[name.slice('carry.'.length)];
    return value === undefined || value === null ? MISSING : { found: true, value };
  }
  if (name.startsWith('env.')) {
    const key = name.slice('env.'.length);
    const value = values.env[key];
    if (value === undefined) throw new TemplateError(`environment variable ${key} is not set`);
    return { found: true, value };
  }
  throw new TemplateError(`unknown placeholder {{${name}}}`);
}

function asText(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function renderString(
  template: string,
  values: TemplateValues,
  encode: (text: string) => string,
): Rendered {
  const whole = WHOLE.exec(template)?.[1];
  if (whole !== undefined) {
    const result = lookup(whole, values);
    if (!result.found) return OMIT;
    return encode === identity ? result.value : encode(asText(result.value));
  }
  return template.replaceAll(PLACEHOLDER, (_match, name: string) => {
    const result = lookup(name, values);
    if (!result.found) throw new TemplateError(`{{${name}}} has no value yet in "${template}"`);
    return encode(asText(result.value));
  });
}

function identity(text: string): string {
  return text;
}

function renderJson(value: JsonValue, values: TemplateValues): Rendered {
  if (typeof value === 'string') return renderString(value, values, identity);
  if (Array.isArray(value)) {
    return value
      .map((item) => renderJson(item, values))
      .filter((item): item is JsonValue => item !== OMIT);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .map(([key, inner]) => [key, renderJson(inner, values)] as const)
      .filter((entry): entry is readonly [string, JsonValue] => entry[1] !== OMIT);
    return Object.fromEntries(entries);
  }
  return value;
}

function isPlainObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Merges `extra` into `base`: objects merge key by key; any other value replaces. */
export function mergeJson(
  base: JsonValue | undefined,
  extra: JsonValue | undefined,
): JsonValue | undefined {
  if (extra === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(extra)) return extra;
  const merged: { [key: string]: JsonValue } = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const next = mergeJson(base[key], value);
    if (next !== undefined) merged[key] = next;
  }
  return merged;
}

function lowerKeys(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

export function buildRequest(
  request: ProfileTarget['request'],
  turn: Pick<CaseTurn, 'request'> | undefined,
  values: TemplateValues,
  /** Headers the runtime adds, such as a client identity or a cache bypass. */
  extraHeaders: Readonly<Record<string, string>> = {},
): BuiltRequest {
  const url = renderString(request.url, values, encodeURIComponent);
  if (url === OMIT)
    throw new TemplateError(`the url "${request.url}" uses a placeholder with no value`);

  const templates: Record<string, string> = {
    ...lowerKeys(request.headers),
    ...lowerKeys(turn?.request?.headers),
  };
  if (request.requestId !== undefined && values.requestId !== undefined) {
    templates[request.requestId.header.toLowerCase()] = values.requestId;
  }
  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries({ ...templates, ...lowerKeys(extraHeaders) })) {
    const value = renderString(template, values, identity);
    if (value === OMIT) continue;
    const text = asText(value);
    if (/[\r\n]/u.test(text))
      throw new TemplateError(`header "${name}" would contain a line break`);
    headers[name] = text;
  }

  const merged = mergeJson(
    request.body === undefined ? undefined : toJson(request.body),
    turn?.request?.body === undefined ? undefined : toJson(turn.request.body),
  );
  const rendered = merged === undefined ? OMIT : renderJson(merged, values);
  const body = rendered === OMIT ? undefined : JSON.stringify(rendered);
  if (body !== undefined && !('content-type' in headers))
    headers['content-type'] = 'application/json';

  return { url: asText(url), method: request.method, headers, body };
}

export interface TemplateCheck {
  /** Problems to fix in the profile or case before running. */
  readonly issues: string[];
  /** Environment variables the templates read; the runtime checks they are set. */
  readonly env: string[];
}

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) collectStrings(inner, into);
  }
}

/** Checks every placeholder before a run, so a typo fails fast instead of mid-run. */
export function checkTemplates(
  target: ProfileTarget,
  turnRequests: readonly unknown[] = [],
): TemplateCheck {
  const strings: string[] = [];
  collectStrings(
    [target.request.url, target.request.headers, target.request.body, turnRequests],
    strings,
  );
  const carried = new Set(target.session.carry.map((entry) => entry.name));
  const issues = new Set<string>();
  const env = new Set<string>();
  for (const text of strings) {
    for (const [, name = ''] of text.matchAll(PLACEHOLDER)) {
      if (name === 'message') continue;
      if (name === 'session') {
        if (target.session.mode === 'none')
          issues.add('{{session}} is used but the session mode is "none"');
      } else if (name === 'requestId') {
        if (target.request.requestId === undefined) {
          issues.add('{{requestId}} is used but request.requestId is not configured');
        }
      } else if (name.startsWith('carry.')) {
        const key = name.slice('carry.'.length);
        if (!carried.has(key)) issues.add(`{{${name}}} is used but session.carry has no "${key}"`);
      } else if (name.startsWith('env.') && name.length > 'env.'.length) {
        env.add(name.slice('env.'.length));
      } else {
        issues.add(`unknown placeholder {{${name}}}`);
      }
    }
  }
  return { issues: [...issues], env: [...env] };
}
