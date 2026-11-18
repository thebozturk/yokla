// The response contract from a contract file (ADR-0057): an OpenAPI 3
// operation, or a JSON Schema document, made into a schema core checks, and
// where in the answer it applies. Pure: the analyzer reads the files and
// verifies the schema against the probes' answers before proposing it.

import { parseJsonPath } from '../extract/jsonpath.ts';

type Schema = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What a contract file is, by its top level; undefined for anything else, Swagger 2 included. */
export function contractKind(document: unknown): 'openapi' | 'json-schema' | undefined {
  if (!isObject(document)) return undefined;
  const version = document['openapi'];
  if (typeof version === 'string') return version.startsWith('3') ? 'openapi' : undefined;
  return namesJsonSchemaDialect(document) ? 'json-schema' : undefined;
}

/**
 * Whether a document's `$schema` names a JSON Schema dialect, a URL on
 * json-schema.org: it is a schema then, not a file that names the schema it
 * follows (ADR-0066).
 */
export function namesJsonSchemaDialect(document: unknown): boolean {
  if (!isObject(document)) return false;
  const dialect = document['$schema'];
  return typeof dialect === 'string' && /^https?:\/\/json-schema\.org\//u.test(dialect);
}

/** The request a contract is read for: the url's path and the method. */
export interface ContractRequest {
  readonly path: string;
  readonly method: string;
}

export type ContractRead =
  | {
      readonly ok: true;
      readonly schema: Schema;
      /** What in the file was read, such as `POST /v1/chat 200 application/json`. */
      readonly read: string;
      /** Keywords left out because core doesn't check them, each with how often. */
      readonly dropped: readonly string[];
    }
  | { readonly ok: false; readonly outcome: 'no-operation' | 'unusable'; readonly problem: string };

/** OpenAPI's keywords outside JSON Schema, which a schema core checks leaves out. */
const OPENAPI_ONLY = new Set(['example', 'discriminator', 'xml', 'externalDocs']);

/** The keywords of a schema that hold schemas, by how they hold them. */
const ONE = ['items', 'not', 'additionalProperties', 'contains'];
const MANY = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const NAMED = ['properties', '$defs', 'definitions', 'patternProperties'];

/** Translates an OpenAPI schema: nullable into a type, its own keywords out, components into $defs. */
class Translator {
  readonly defs: Record<string, unknown> = {};
  readonly #components: Record<string, unknown>;
  readonly #counts = new Map<string, number>();

  constructor(components: Record<string, unknown>) {
    this.#components = components;
  }

  get dropped(): string[] {
    return [...this.#counts].map(([keyword, count]) => `${keyword} (${String(count)})`);
  }

  #drop(keyword: string): void {
    this.#counts.set(keyword, (this.#counts.get(keyword) ?? 0) + 1);
  }

  translate(node: unknown): unknown {
    if (!isObject(node)) return node;
    const out: Schema = {};
    for (const [keyword, value] of Object.entries(node)) {
      if (keyword === 'nullable') continue;
      if (OPENAPI_ONLY.has(keyword) || keyword.startsWith('x-')) {
        this.#drop(keyword);
        continue;
      }
      if (keyword === '$ref' && typeof value === 'string') {
        out[keyword] = this.#ref(value);
      } else if (ONE.includes(keyword)) {
        out[keyword] = this.translate(value);
      } else if (MANY.includes(keyword) && Array.isArray(value)) {
        out[keyword] = value.map((item) => this.translate(item));
      } else if (NAMED.includes(keyword) && isObject(value)) {
        out[keyword] = Object.fromEntries(
          Object.entries(value).map(([name, item]) => [name, this.translate(item)]),
        );
      } else {
        out[keyword] = value;
      }
    }
    // OpenAPI 3.0: nullable adds null to the type.
    if (node['nullable'] === true) {
      const type: unknown = out['type'];
      if (typeof type === 'string') out['type'] = [type, 'null'];
      else if (Array.isArray(type) && !type.includes('null')) {
        out['type'] = [...type.filter((item): item is string => typeof item === 'string'), 'null'];
      }
    }
    return out;
  }

  /** A component reference, moved into $defs; any other reference as it is. */
  #ref(ref: string): string {
    const match = /^#\/components\/schemas\/([^/]+)$/u.exec(ref);
    const name = match?.[1];
    if (name === undefined) return ref;
    if (!(name in this.defs)) {
      this.defs[name] = true;
      this.defs[name] = this.translate(this.#components[name]);
    }
    return `#/$defs/${name}`;
  }
}

/** A path template's pattern: a {parameter} matches one segment. */
function templatePattern(template: string): RegExp {
  const escaped = template
    .split(/\{[^}]+\}/u)
    .map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${escaped}$`, 'u');
}

/** The paths the servers' urls hold, longest first, and none. */
function serverPaths(document: Schema): string[] {
  const servers = Array.isArray(document['servers']) ? document['servers'] : [];
  const paths = servers.flatMap((server: unknown) => {
    const url = isObject(server) ? server['url'] : undefined;
    if (typeof url !== 'string') return [];
    // The url's path: after any scheme and host, before any query, without a closing "/".
    const path = url
      .replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*/iu, '')
      .replace(/[?#].*$/u, '')
      .replace(/\/+$/u, '');
    return [path.startsWith('/') || path === '' ? path : `/${path}`];
  });
  return [...new Set([...paths, ''])].toSorted((a, b) => b.length - a.length);
}

/** Resolves a reference into the document, such as #/components/responses/Answer. */
function resolve(document: Schema, node: unknown): unknown {
  if (!isObject(node) || typeof node['$ref'] !== 'string') return node;
  const ref = node['$ref'];
  if (!ref.startsWith('#/')) return node;
  let at: unknown = document;
  for (const part of ref.slice(2).split('/')) {
    at = isObject(at) ? at[part.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined;
  }
  return at;
}

/** The status read from a response map: the lowest 2xx, else 2XX, else default. */
function statusOf(responses: Schema): string | undefined {
  // An object's integer keys come in ascending order: the first is the lowest.
  const codes = Object.keys(responses).filter((code) => /^2\d\d$/u.test(code));
  return codes[0] ?? ['2XX', 'default'].find((code) => code in responses);
}

/** The operation an OpenAPI 3 document gives the request, made into a schema core checks. */
export function readOpenApi(document: Schema, request: ContractRequest): ContractRead {
  const method = request.method.toLowerCase();
  const paths = isObject(document['paths']) ? document['paths'] : {};
  // Literal paths before templated ones, then by name.
  const templates = Object.keys(paths).toSorted(
    (a, b) =>
      (a.match(/\{/gu)?.length ?? 0) - (b.match(/\{/gu)?.length ?? 0) ||
      (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const prefix of serverPaths(document)) {
    if (!request.path.startsWith(prefix)) continue;
    const rest = request.path.slice(prefix.length) || '/';
    const template = templates.find((candidate) => templatePattern(candidate).test(rest));
    const item = template === undefined ? undefined : resolve(document, paths[template]);
    const operation = isObject(item) ? item[method] : undefined;
    if (template === undefined || !isObject(operation)) continue;
    const named = `${request.method.toUpperCase()} ${template}`;
    const responses = isObject(operation['responses']) ? operation['responses'] : {};
    const status = statusOf(responses);
    const response = status === undefined ? undefined : resolve(document, responses[status]);
    const content = isObject(response) && isObject(response['content']) ? response['content'] : {};
    const type =
      'application/json' in content
        ? 'application/json'
        : Object.keys(content).find((name) => /^application\/(?:[\w.-]+\+)?json\b/u.test(name));
    const media = type === undefined ? undefined : content[type];
    const schema = isObject(media) ? media['schema'] : undefined;
    if (status === undefined || type === undefined || !isObject(schema)) {
      return {
        ok: false,
        outcome: 'unusable',
        problem: `${named} has no 2xx JSON response schema`,
      };
    }
    const components = isObject(document['components']) ? document['components'] : {};
    const translator = new Translator(isObject(components['schemas']) ? components['schemas'] : {});
    const root = translator.translate(schema);
    const defs = translator.defs;
    return {
      ok: true,
      schema: {
        ...(isObject(root) ? root : {}),
        ...(Object.keys(defs).length === 0 ? {} : { $defs: defs }),
      },
      read: `${named} ${status} ${type}`,
      dropped: translator.dropped,
    };
  }
  return {
    ok: false,
    outcome: 'no-operation',
    problem: `no operation for ${request.method.toUpperCase()} ${request.path}`,
  };
}

/** A JSON Schema document: the whole of it. */
export function readJsonSchema(document: Schema): ContractRead {
  return { ok: true, schema: document, read: 'the whole schema', dropped: [] };
}

/** The leading names of a JSONPath, up to its first index or wildcard. */
function names(path: string): string[] {
  const chain: string[] = [];
  for (const segment of parseJsonPath(path)) {
    if (segment.kind !== 'name') break;
    chain.push(segment.name);
  }
  return chain;
}

/** A schema node with a $defs reference followed. */
function follow(root: Schema, node: unknown): unknown {
  const ref = isObject(node) ? node['$ref'] : undefined;
  const name = typeof ref === 'string' ? /^#\/\$defs\/([^/]+)$/u.exec(ref)?.[1] : undefined;
  const defs = isObject(root['$defs']) ? root['$defs'] : {};
  return name === undefined ? node : defs[name];
}

/** The $defs a schema node refers to, and those they refer to. */
function reachable(root: Schema, node: unknown, found = new Set<string>()): Set<string> {
  const defs = isObject(root['$defs']) ? root['$defs'] : {};
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isObject(value)) return;
    const ref = value['$ref'];
    const name = typeof ref === 'string' ? /^#\/\$defs\/([^/]+)$/u.exec(ref)?.[1] : undefined;
    if (name !== undefined && !found.has(name)) {
      found.add(name);
      walk(defs[name]);
    }
    for (const [keyword, item] of Object.entries(value)) if (keyword !== '$defs') walk(item);
  };
  walk(node);
  return found;
}

const segmentOf = (name: string): string =>
  /^[A-Za-z_][\w-]*$/u.test(name) ? `.${name}` : `['${name}']`;

/**
 * Where a contract applies: the deepest object path that the answer's text
 * path and every evidence path share, where the schema describes an object;
 * else the whole answer, at `$`. The schema is the part that describes it,
 * with the $defs it refers to.
 */
export function contractAt(
  schema: Schema,
  textPath: string,
  evidencePaths: readonly string[],
): { readonly at: string; readonly schema: Schema } {
  // Each path's holder: its names without the last, the field or the collection itself.
  const holders = [textPath, ...evidencePaths].map((path) => names(path).slice(0, -1));
  const [first = []] = holders;
  const shared: string[] = [];
  for (const [index, name] of first.entries()) {
    if (!holders.every((holder) => holder[index] === name)) break;
    shared.push(name);
  }
  let node: unknown = schema;
  for (const name of shared) {
    const here = follow(schema, node);
    const properties = isObject(here) ? here['properties'] : undefined;
    if (!isObject(properties) || !(name in properties)) return { at: '$', schema };
    node = properties[name];
  }
  const part = follow(schema, node);
  const isObjectSchema =
    isObject(part) && (part['type'] === 'object' || isObject(part['properties']));
  if (shared.length === 0 || !isObjectSchema) return { at: '$', schema };
  const defs = isObject(schema['$defs']) ? schema['$defs'] : {};
  const used = [...reachable(schema, part)].toSorted();
  const { $defs: _own, ...body } = part;
  return {
    at: `$${shared.map(segmentOf).join('')}`,
    schema: {
      ...body,
      ...(used.length === 0
        ? {}
        : { $defs: Object.fromEntries(used.map((name) => [name, defs[name]])) }),
    },
  };
}
