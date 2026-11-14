// Checks the user writes (ADR-0030), by contract version 1. A module that
// yokla.config.yaml names default-exports a definition: its id, description,
// dimension, optionally a policy for a dimension of its own and a JSON Schema
// for the value cases give it as expect.custom.<id>, and a synchronous run.
// run gets a frozen copy of the turn made for this contract, never yokla's
// internal view, and returns not applicable or at least one finding. An
// exception, or a result outside the contract, becomes an error finding.
// Fields are only ever added to version 1; changing one needs a new version.

import { z } from 'zod';
import { toJson, type EvidenceItem, type JsonValue } from '../extract/response.ts';
import { compileSchema, validateCompiled, type CompiledSchema } from '../jsonschema/jsonschema.ts';
import { JsonSchemaValue } from '../schema/common.ts';
import type { Case } from '../schema/cases.ts';
import type { AggregationPolicy, Check, CheckFinding, FindingSeverity } from './types.ts';

export const USER_CHECK_API = 1;

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** What a check's run gets, by contract version 1. */
export interface UserTurn {
  readonly case: { readonly id: string; readonly suite: string; readonly language: string };
  /** The turn's place in its sample, from 0. */
  readonly index: number;
  readonly user: string;
  /** The value the case gives this check as expect.custom.<id>, if any. */
  readonly expect?: JsonValue;
  readonly answer: {
    readonly status: number;
    readonly latencyMs: number;
    readonly text: string;
    /** null when the profile maps no route, or the answer has none. */
    readonly route: string | null;
    readonly evidence: Readonly<Record<string, readonly EvidenceItem[]>>;
  };
  /** The earlier turns of the sample, oldest first. */
  readonly history: readonly { readonly user: string; readonly text: string }[];
}

const SEVERITIES = [
  'info',
  'low',
  'medium',
  'high',
  'critical',
] as const satisfies readonly FindingSeverity[];

/** A module's default export, as contract version 1 defines it. */
export const UserCheckDefinition = z.strictObject({
  api: z.literal(USER_CHECK_API, { error: 'api must be 1, the contract version this yokla runs' }),
  id: z.string().regex(KEBAB, 'use a kebab-case id, such as no-internal-ids'),
  description: z.string().min(1),
  dimension: z.string().regex(KEBAB, 'use a kebab-case dimension, such as answer-content'),
  policy: z.enum(['worst-of-n', 'majority-of-n', 'advisory']).optional(),
  expect: JsonSchemaValue.optional(),
  run: z.custom<(turn: UserTurn) => unknown>((value) => typeof value === 'function', {
    error: 'run must be a function',
  }),
});
export type UserCheckDefinition = z.output<typeof UserCheckDefinition>;

const NotApplicable = z.strictObject({
  applicable: z.literal(false),
  reason: z.string().min(1),
});

const Applicable = z.strictObject({
  applicable: z.literal(true).optional(),
  findings: z
    .array(
      z.strictObject({
        verdict: z.enum(['pass', 'fail']),
        message: z.string().min(1),
        severity: z.enum(SEVERITIES).optional(),
        evidence: z.json().optional(),
      }),
    )
    .min(1, 'an applicable result needs at least one finding'),
});

/** Freezes a value and everything in it, so a check can't change what others see. */
function freeze(node: unknown): void {
  if (typeof node !== 'object' || node === null) return;
  Object.freeze(node);
  for (const inner of Object.values(node)) freeze(inner);
}

/** The evidence, copied: its items are the turn's, which other checks read. */
function copied(
  evidence: Readonly<Record<string, readonly EvidenceItem[]>>,
): Record<string, EvidenceItem[]> {
  return Object.fromEntries(
    Object.entries(evidence).map(([name, items]) => [
      name,
      items.map((item) =>
        Object.fromEntries(Object.entries(item).map(([field, value]) => [field, toJson(value)])),
      ),
    ]),
  );
}

function customOf(expect: Readonly<Record<string, unknown>>, id: string): unknown {
  const custom = expect['custom'];
  return typeof custom === 'object' && custom !== null ? Reflect.get(custom, id) : undefined;
}

/** A user's check, bound into yokla's check interface. */
export function userCheck(definition: UserCheckDefinition): Check {
  const { id, dimension } = definition;
  return {
    id,
    description: definition.description,
    run(context) {
      const { turn } = context;
      const given = customOf(turn.expect, id);
      const view: UserTurn = {
        case: { id: context.case.id, suite: context.case.suite, language: context.case.language },
        index: context.turnIndex,
        user: turn.user,
        ...(given === undefined ? {} : { expect: toJson(given) }),
        answer: {
          status: turn.response.status,
          latencyMs: turn.response.latencyMs,
          text: turn.response.text,
          route: turn.response.route ?? null,
          evidence: copied(turn.response.evidence),
        },
        history: context.history.map((earlier) => ({
          user: earlier.user,
          text: earlier.response.text,
        })),
      };
      freeze(view);
      const returned = definition.run(view);
      if (returned instanceof Promise) {
        void returned.catch(() => undefined);
        throw new Error('run returned a promise: a check runs synchronously');
      }
      // Judged against the form it claims, so the problem named is the one it has.
      const claimsNone =
        typeof returned === 'object' &&
        returned !== null &&
        Reflect.get(returned, 'applicable') === false;
      const parsed = claimsNone
        ? NotApplicable.safeParse(returned)
        : Applicable.safeParse(returned);
      if (!parsed.success) {
        const [issue] = parsed.error.issues;
        const where = issue?.path.map(String).join('.') ?? '';
        throw new Error(
          `run returned what contract 1 doesn't allow: ${where === '' ? '' : `${where}: `}${issue?.message ?? 'invalid'}`,
        );
      }
      const outcome = parsed.data;
      if ('reason' in outcome) return { applicable: false, reason: outcome.reason };
      return {
        applicable: true,
        findings: outcome.findings.map((finding): CheckFinding => ({
          dimension,
          verdict: finding.verdict,
          severity: finding.severity ?? 'medium',
          message: finding.message,
          ...(finding.evidence === undefined ? {} : { evidence: finding.evidence }),
        })),
      };
    },
  };
}

/**
 * The policies user checks set for dimensions of their own; a problem for a
 * policy on a dimension a built-in check reports, which keeps its own.
 */
export function userPolicies(
  definitions: readonly UserCheckDefinition[],
  builtIn: ReadonlySet<string>,
): { policies: Record<string, AggregationPolicy>; problems: string[] } {
  const policies: Record<string, AggregationPolicy> = {};
  const problems: string[] = [];
  for (const { id, dimension, policy } of definitions) {
    if (policy === undefined) continue;
    if (builtIn.has(dimension)) {
      problems.push(
        `check "${id}" sets a policy for "${dimension}", a dimension of yokla's own checks, which keeps its own`,
      );
    } else if (policies[dimension] !== undefined && policies[dimension] !== policy) {
      problems.push(`check "${id}" sets another policy for "${dimension}"`);
    } else policies[dimension] = policy;
  }
  return { policies, problems };
}

/**
 * Problems with the values cases give user checks as expect.custom: a value
 * for no loaded check, for a check that takes none, or one its schema refuses.
 */
export function customProblems(
  cases: readonly Case[],
  definitions: readonly UserCheckDefinition[],
): string[] {
  const schemas = new Map<string, CompiledSchema | undefined>(
    definitions.map((definition) => [
      definition.id,
      definition.expect === undefined ? undefined : compileSchema(definition.expect),
    ]),
  );
  const problems: string[] = [];
  const judge = (where: string, expect: Readonly<Record<string, unknown>> | undefined) => {
    const custom = expect?.['custom'];
    if (typeof custom !== 'object' || custom === null) return;
    for (const [id, value] of Object.entries(custom)) {
      const at = `${where}: expect.custom.${id}`;
      if (!schemas.has(id)) {
        problems.push(`${at}: no loaded check has this id`);
        continue;
      }
      const schema = schemas.get(id);
      if (schema === undefined) {
        problems.push(`${at}: the check takes no value; it declares no expect schema`);
        continue;
      }
      const [first] = validateCompiled(schema, value);
      if (first !== undefined) {
        problems.push(`${at}: ${first.path}: ${first.keyword}, ${first.message}`);
      }
    }
  };
  for (const testCase of cases) {
    testCase.turns.forEach((turn, index) => {
      judge(`case "${testCase.id}" turn ${String(index + 1)}`, turn.expect);
    });
    judge(`case "${testCase.id}" customer`, testCase.customer?.expect);
  }
  return problems;
}
