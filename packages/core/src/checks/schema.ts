// json-schema (ADR-0030): the response, or a part of it, matches a JSON
// Schema. The profile's target.response.schema is the contract of every
// usable answer; a turn's expect.schema adds its own. Every value a rule's
// path selects must match, and a path that selects nothing fails: the
// contract says the part is there. A finding names each broken rule by the
// value's path and its keyword, never the value.

import { selectJsonPath } from '../extract/jsonpath.ts';
import { compileSchema, validateCompiled, type Violation } from '../jsonschema/jsonschema.ts';
import { coreExpectations } from '../schema/cases.ts';
import type { SchemaRule } from '../schema/common.ts';
import type { Check, CheckFinding } from './types.ts';

/** At most this many broken rules are kept per finding. */
export const MAX_VIOLATIONS = 10;

const WHERE = { profile: ' (target.response.schema)', turn: '' } as const;

function judged(rule: SchemaRule, from: 'profile' | 'turn', document: unknown): CheckFinding {
  if (rule.schema === undefined) {
    // The loader reads schemaFile into schema; a rule without one is a bug, reported as an error.
    throw new Error(`the schema in ${rule.schemaFile ?? 'schemaFile'} was not read`);
  }
  const schema = compileSchema(rule.schema);
  const selected = selectJsonPath(document, rule.at);
  if (selected.length === 0) {
    return {
      dimension: 'contract',
      verdict: 'fail',
      severity: 'high',
      message: `nothing at ${rule.at}${WHERE[from]}`,
      evidence: { at: rule.at, from },
    };
  }
  const violations: Violation[] = selected.flatMap(({ path, value }) =>
    validateCompiled(schema, value, path),
  );
  const [first] = violations;
  if (first === undefined) {
    return {
      dimension: 'contract',
      verdict: 'pass',
      severity: 'high',
      message: `matches the schema at ${rule.at}${WHERE[from]}`,
      evidence: { at: rule.at, from },
    };
  }
  const more = violations.length > 1 ? `, and ${String(violations.length - 1)} more` : '';
  return {
    dimension: 'contract',
    verdict: 'fail',
    severity: 'high',
    message: `breaks the schema at ${rule.at}${WHERE[from]}: ${first.path}: ${first.keyword}, ${first.message}${more}`,
    evidence: {
      at: rule.at,
      from,
      violations: violations
        .slice(0, MAX_VIOLATIONS)
        .map(({ path, keyword, message }) => ({ path, keyword, message })),
      total: violations.length,
    },
  };
}

export const jsonSchemaCheck: Check = {
  id: 'json-schema',
  description: 'The response, or a part of it, matches its JSON Schema.',
  run(context) {
    const contract = context.profile.target.response.schema;
    const parsed = coreExpectations.schema.safeParse(context.turn.expect['schema']);
    const rules: [SchemaRule, 'profile' | 'turn'][] = [
      ...(contract === undefined ? [] : [[contract, 'profile'] as [SchemaRule, 'profile']]),
      ...(parsed.success ? parsed.data : []).map((rule): [SchemaRule, 'turn'] => [rule, 'turn']),
    ];
    if (rules.length === 0) return { applicable: false, reason: 'no schema for the response' };
    const { document } = context.turn.response;
    if (document === undefined) return { applicable: false, reason: 'the response is not JSON' };
    return {
      applicable: true,
      findings: rules.map(([rule, from]) => judged(rule, from, document)),
    };
  },
};
