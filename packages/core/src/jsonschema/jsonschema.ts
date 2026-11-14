// JSON Schema as far as yokla checks it (ADR-0030): a subset of draft 2020-12,
// validated here with no dependency. A schema is first compiled into typed
// nodes; anything outside the subset is a problem that refuses it when it
// loads, with the keyword and where it is, so no rule passes unchecked. A
// `$ref` points inside the schema and is never fetched (ADR-0003). A
// violation names the value's path and the rule it breaks, never the value.

import { childPath } from '../extract/member.ts';

/** A schema as written: an object of keywords, or a boolean. */
export type JsonSchema = boolean | { readonly [keyword: string]: unknown };

export interface Violation {
  /** Where the value is, as a JSONPath such as `$.data.items[0].price`. */
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

/** Read and ignored, as 2020-12 defines them. */
const ANNOTATIONS: ReadonlySet<string> = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

const TYPES: readonly string[] = [
  'null',
  'boolean',
  'object',
  'array',
  'number',
  'integer',
  'string',
];

type Count =
  'minProperties' | 'maxProperties' | 'minItems' | 'maxItems' | 'minLength' | 'maxLength';
const COUNTS: readonly Count[] = [
  'minProperties',
  'maxProperties',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
];

type Bound = 'minimum' | 'maximum' | 'exclusiveMinimum' | 'exclusiveMaximum';
const BOUNDS: readonly Bound[] = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'];

/** A schema compiled: each keyword it uses, typed. */
interface Rules {
  ref?: string;
  types?: readonly string[];
  enum?: readonly unknown[];
  const?: { readonly value: unknown };
  allOf?: readonly Node[];
  anyOf?: readonly Node[];
  oneOf?: readonly Node[];
  not?: Node;
  properties?: ReadonlyMap<string, Node>;
  required?: readonly string[];
  additionalProperties?: Node;
  prefixItems?: readonly Node[];
  items?: Node;
  uniqueItems?: boolean;
  pattern?: RegExp;
  format?: string;
  multipleOf?: number;
  readonly counts: Partial<Record<Count, number>>;
  readonly bounds: Partial<Record<Bound, number>>;
}

type Node = boolean | Rules;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  // A month outside 1 to 12 has no days.
  const most = month === 2 && !leap ? 28 : (DAYS[month - 1] ?? 0);
  return day >= 1 && day <= most;
}

function isTime(text: string): boolean {
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:z|[+-](\d{2}):(\d{2}))$/iu.exec(text);
  if (match === null) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  const offsetHour = Number(match[4] ?? '0');
  const offsetMinute = Number(match[5] ?? '0');
  // A leap second is 60.
  return hour <= 23 && minute <= 59 && second <= 60 && offsetHour <= 23 && offsetMinute <= 59;
}

/** The formats yokla checks; any other is refused when the schema loads. */
const FORMATS: Readonly<Record<string, (text: string) => boolean>> = {
  'date-time': (text) => {
    const [date, time, ...rest] = text.split(/t/iu);
    return rest.length === 0 && isDate(date ?? '') && isTime(time ?? '');
  },
  date: isDate,
  time: isTime,
  // A simple form: something, an @, and a domain, with no spaces.
  email: (text) => /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*$/u.test(text),
  // An absolute URI: a scheme, a colon, and no spaces.
  uri: (text) => /^[a-z][a-z\d+.-]*:\S*$/iu.test(text),
  uuid: (text) => /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(text),
};

/** A JSON Pointer segment, escaped. */
function escapeSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** The pointer a `$ref` names, decoded, or undefined when it points outside the schema. */
function refPointer(ref: string): string | undefined {
  if (!ref.startsWith('#')) return undefined;
  try {
    return `#${decodeURIComponent(ref.slice(1))}`;
  } catch {
    return undefined;
  }
}

/** A schema compiled, with every schema in it by its pointer, and what is wrong with it. */
export interface CompiledSchema {
  readonly root: Node;
  readonly nodes: ReadonlyMap<string, Node>;
  readonly problems: readonly string[];
}

class Compiler {
  readonly #problems: string[] = [];
  readonly #nodes = new Map<string, Node>();
  readonly #refs: { at: string; ref: string }[] = [];

  compile(schema: unknown): CompiledSchema {
    const root = this.#node(schema, '#');
    for (const { at, ref } of this.#refs) {
      const pointer = refPointer(ref);
      if (pointer === undefined || !this.#nodes.has(pointer)) {
        this.#problems.push(`${at}: "${ref}" points to no schema in it`);
      }
    }
    return { root, nodes: this.#nodes, problems: this.#problems };
  }

  #list(value: unknown, at: string, problem: (what: string) => void): Node[] | undefined {
    if (!Array.isArray(value) || value.length === 0) {
      problem('a list of schemas');
      return undefined;
    }
    const list: readonly unknown[] = value;
    return list.map((sub, index) => this.#node(sub, `${at}/${String(index)}`));
  }

  #node(schema: unknown, at: string): Node {
    let node: Node;
    if (typeof schema === 'boolean') node = schema;
    else if (isObject(schema)) node = this.#rules(schema, at);
    else {
      this.#problems.push(`${at}: a schema is an object or a boolean`);
      node = true;
    }
    this.#nodes.set(at, node);
    return node;
  }

  #rules(schema: Record<string, unknown>, at: string): Rules {
    const rules: Rules = { counts: {}, bounds: {} };
    for (const [keyword, value] of Object.entries(schema)) {
      const here = `${at}/${escapeSegment(keyword)}`;
      const problem = (what: string) => {
        this.#problems.push(`${here}: ${what}`);
      };
      if (!ANNOTATIONS.has(keyword)) this.#keyword(rules, keyword, value, here, problem);
    }
    return rules;
  }

  #keyword(
    rules: Rules,
    keyword: string,
    value: unknown,
    here: string,
    problem: (what: string) => void,
  ): void {
    const countKey = COUNTS.find((name) => name === keyword);
    const boundKey = BOUNDS.find((name) => name === keyword);
    if (countKey !== undefined) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        rules.counts[countKey] = value;
      } else problem('a whole number, 0 or more');
    } else if (boundKey !== undefined) {
      if (typeof value === 'number' && Number.isFinite(value)) rules.bounds[boundKey] = value;
      else problem('a number');
    } else if (keyword === 'const') {
      rules.const = { value };
    } else if (keyword === 'type') {
      const list: readonly unknown[] = Array.isArray(value) ? value : [value];
      const names = list.filter((name): name is string => typeof name === 'string');
      if (
        list.length > 0 &&
        names.length === list.length &&
        new Set(names).size === names.length &&
        names.every((name) => TYPES.includes(name))
      ) {
        rules.types = names;
      } else problem(`a type, or a list of types, from ${TYPES.join(', ')}`);
    } else if (keyword === 'enum') {
      if (Array.isArray(value) && value.length > 0) {
        const allowed: readonly unknown[] = value;
        rules.enum = allowed;
      } else problem('a list of values');
    } else if (keyword === 'allOf' || keyword === 'anyOf' || keyword === 'oneOf') {
      const list = this.#list(value, here, problem);
      if (list !== undefined) rules[keyword] = list;
    } else if (keyword === 'prefixItems') {
      const list = this.#list(value, here, problem);
      if (list !== undefined) rules.prefixItems = list;
    } else if (keyword === 'not' || keyword === 'items' || keyword === 'additionalProperties') {
      rules[keyword] = this.#node(value, here);
    } else if (keyword === 'properties' || keyword === '$defs') {
      if (!isObject(value)) problem('an object of schemas');
      else {
        const nodes = new Map(
          Object.entries(value).map(([name, sub]) => [
            name,
            this.#node(sub, `${here}/${escapeSegment(name)}`),
          ]),
        );
        if (keyword === 'properties') rules.properties = nodes;
      }
    } else if (keyword === 'required') {
      const list: readonly unknown[] = Array.isArray(value) ? value : [];
      const names = list.filter((name): name is string => typeof name === 'string');
      if (
        Array.isArray(value) &&
        names.length === list.length &&
        new Set(names).size === names.length
      ) {
        rules.required = names;
      } else problem('a list of property names, each once');
    } else if (keyword === 'uniqueItems') {
      if (typeof value === 'boolean') rules.uniqueItems = value;
      else problem('true or false');
    } else if (keyword === 'multipleOf') {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        rules.multipleOf = value;
      } else problem('a number above 0');
    } else if (keyword === 'pattern') {
      try {
        if (typeof value !== 'string') throw new TypeError('not a string');
        rules.pattern = new RegExp(value, 'u');
      } catch {
        problem('a valid regular expression');
      }
    } else if (keyword === 'format') {
      if (typeof value === 'string' && Object.hasOwn(FORMATS, value)) rules.format = value;
      else {
        problem(
          `the format ${JSON.stringify(value)} isn't checked; yokla checks ${Object.keys(FORMATS).join(', ')}`,
        );
      }
    } else if (keyword === '$ref') {
      if (typeof value === 'string' && refPointer(value) !== undefined) {
        rules.ref = value;
        this.#refs.push({ at: here, ref: value });
      } else {
        problem(`${JSON.stringify(value)} points outside the schema, which yokla never fetches`);
      }
    } else {
      problem(`the keyword "${keyword}" isn't checked`);
    }
  }
}

/** The schema compiled into typed nodes; its problems refuse it. */
export function compileSchema(schema: unknown): CompiledSchema {
  return new Compiler().compile(schema);
}

/**
 * What is wrong with a schema: keywords yokla doesn't check, values a keyword
 * can't take, and references that point outside it or nowhere. Empty when it
 * can be used.
 */
export function schemaProblems(schema: unknown): string[] {
  return [...compileSchema(schema).problems];
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function hasType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

/** JSON equality: objects equal whatever the order of their keys. */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    const left: readonly unknown[] = a;
    const right: readonly unknown[] = b;
    return left.length === right.length && left.every((item, index) => equal(item, right[index]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
    );
  }
  return false;
}

function isMultiple(value: number, of: number): boolean {
  const quotient = value / of;
  return Math.abs(quotient - Math.round(quotient)) <= 1e-9 * Math.max(1, Math.abs(quotient));
}

function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${String(n)} ${n === 1 ? noun : plural}`;
}

/** The first two equal items, by index. */
function duplicateOf(value: readonly unknown[]): [number, number] | undefined {
  for (let first = 0; first < value.length; first += 1) {
    for (let second = first + 1; second < value.length; second += 1) {
      if (equal(value[first], value[second])) return [first, second];
    }
  }
  return undefined;
}

type Report = (keyword: string, message: string, at?: string) => void;

class Validator {
  readonly #schema: CompiledSchema;
  readonly #out: Violation[] = [];
  /** The references being followed at each path, so one that loops is caught. */
  readonly #following: Set<string>;

  constructor(schema: CompiledSchema, following: ReadonlySet<string> = new Set()) {
    this.#schema = schema;
    this.#following = new Set(following);
  }

  violations(node: Node, value: unknown, path: string): Violation[] {
    this.#check(node, value, path);
    return this.#out;
  }

  /** Whether the value matches the node, without reporting why not. */
  #matches(node: Node, value: unknown, path: string): boolean {
    return new Validator(this.#schema, this.#following).violations(node, value, path).length === 0;
  }

  #check(node: Node, value: unknown, path: string): void {
    const report: Report = (keyword, message, at = path) => {
      this.#out.push({ path: at, keyword, message });
    };
    if (node === true) return;
    if (node === false) {
      report('false', 'no value is allowed here');
      return;
    }
    if (node.ref !== undefined) this.#follow(node.ref, value, path, report);
    if (node.types !== undefined && !node.types.some((type) => hasType(value, type))) {
      report('type', `expected ${node.types.join(' or ')}, got ${typeOf(value)}`);
    }
    if (node.enum !== undefined && !node.enum.some((allowed) => equal(allowed, value))) {
      report('enum', `not one of the ${count(node.enum.length, 'allowed value')}`);
    }
    if (node.const !== undefined && !equal(node.const.value, value)) {
      report('const', 'not the expected value');
    }
    for (const sub of node.allOf ?? []) this.#check(sub, value, path);
    if (node.anyOf !== undefined && !node.anyOf.some((sub) => this.#matches(sub, value, path))) {
      report('anyOf', `matches none of the ${count(node.anyOf.length, 'schema')}`);
    }
    if (node.oneOf !== undefined) {
      const matching = node.oneOf.filter((sub) => this.#matches(sub, value, path)).length;
      if (matching !== 1) {
        report(
          'oneOf',
          `matches ${String(matching)} of the ${count(node.oneOf.length, 'schema')}, not exactly one`,
        );
      }
    }
    if (node.not !== undefined && this.#matches(node.not, value, path)) {
      report('not', 'matches the schema it must not');
    }
    if (isObject(value)) this.#object(node, value, path, report);
    if (Array.isArray(value)) this.#array(node, value, path, report);
    if (typeof value === 'string') this.#string(node, value, report);
    if (typeof value === 'number') this.#number(node, value, report);
  }

  #follow(ref: string, value: unknown, path: string, report: Report): void {
    const key = `${ref} ${path}`;
    const target = this.#schema.nodes.get(refPointer(ref) ?? '');
    if (this.#following.has(key)) {
      report('$ref', `${ref} refers to itself without reaching a value`);
    } else if (target !== undefined) {
      this.#following.add(key);
      this.#check(target, value, path);
      this.#following.delete(key);
    }
  }

  #object(node: Rules, value: Record<string, unknown>, path: string, report: Report): void {
    const properties = node.properties ?? new Map<string, Node>();
    for (const [name, sub] of properties) {
      if (Object.hasOwn(value, name)) this.#check(sub, value[name], childPath(path, name));
    }
    for (const name of node.required ?? []) {
      if (!Object.hasOwn(value, name)) report('required', `"${name}" is missing`);
    }
    const additional = node.additionalProperties;
    if (additional !== undefined) {
      for (const name of Object.keys(value)) {
        if (properties.has(name)) continue;
        if (additional === false) {
          report('additionalProperties', 'not allowed', childPath(path, name));
        } else this.#check(additional, value[name], childPath(path, name));
      }
    }
    const size = Object.keys(value).length;
    const { minProperties: min, maxProperties: max } = node.counts;
    if (min !== undefined && size < min) {
      report('minProperties', `${count(size, 'property', 'properties')}, at least ${String(min)}`);
    }
    if (max !== undefined && size > max) {
      report('maxProperties', `${count(size, 'property', 'properties')}, at most ${String(max)}`);
    }
  }

  #array(node: Rules, value: readonly unknown[], path: string, report: Report): void {
    const prefix = node.prefixItems ?? [];
    prefix.forEach((sub, index) => {
      if (index < value.length) this.#check(sub, value[index], `${path}[${String(index)}]`);
    });
    if (node.items !== undefined) {
      for (let index = prefix.length; index < value.length; index += 1) {
        this.#check(node.items, value[index], `${path}[${String(index)}]`);
      }
    }
    const { minItems: min, maxItems: max } = node.counts;
    if (min !== undefined && value.length < min) {
      report('minItems', `${count(value.length, 'item')}, at least ${String(min)}`);
    }
    if (max !== undefined && value.length > max) {
      report('maxItems', `${count(value.length, 'item')}, at most ${String(max)}`);
    }
    const duplicate = node.uniqueItems === true ? duplicateOf(value) : undefined;
    if (duplicate !== undefined) {
      report('uniqueItems', `items ${String(duplicate[0])} and ${String(duplicate[1])} are equal`);
    }
  }

  #string(node: Rules, value: string, report: Report): void {
    // Length in characters, as JSON Schema counts them: code points.
    const length = Array.from(value).length;
    const { minLength: min, maxLength: max } = node.counts;
    if (min !== undefined && length < min) {
      report('minLength', `${count(length, 'character')}, at least ${String(min)}`);
    }
    if (max !== undefined && length > max) {
      report('maxLength', `${count(length, 'character')}, at most ${String(max)}`);
    }
    if (node.pattern !== undefined && !node.pattern.test(value)) {
      report('pattern', `doesn't match /${node.pattern.source}/`);
    }
    if (node.format !== undefined && FORMATS[node.format]?.(value) !== true) {
      report('format', `not a ${node.format}`);
    }
  }

  #number(node: Rules, value: number, report: Report): void {
    const { minimum, maximum, exclusiveMinimum: above, exclusiveMaximum: below } = node.bounds;
    if (minimum !== undefined && value < minimum) report('minimum', `less than ${String(minimum)}`);
    if (maximum !== undefined && value > maximum) report('maximum', `more than ${String(maximum)}`);
    if (above !== undefined && value <= above) {
      report('exclusiveMinimum', `not more than ${String(above)}`);
    }
    if (below !== undefined && value >= below) {
      report('exclusiveMaximum', `not less than ${String(below)}`);
    }
    if (node.multipleOf !== undefined && !isMultiple(value, node.multipleOf)) {
      report('multipleOf', `not a multiple of ${String(node.multipleOf)}`);
    }
  }
}

/** Every rule of a compiled schema the value breaks. */
export function validateCompiled(schema: CompiledSchema, value: unknown, path = '$'): Violation[] {
  return new Validator(schema).violations(schema.root, value, path);
}

/** Every rule of the schema the value breaks; the schema must have no problems. */
export function validateJson(schema: JsonSchema, value: unknown, path = '$'): Violation[] {
  return validateCompiled(compileSchema(schema), value, path);
}
