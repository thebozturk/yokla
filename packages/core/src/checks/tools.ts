// The tool-call checks (ADR-0025): they read the tool calls the model proxy
// saw the turn's model calls ask for, in the order the calls started.
// - tool-calls judges what the case expects of them;
// - tool-call-valid judges, with no expectation, that each call asked only for
//   tools that call offered, with arguments that are valid JSON.
// A trajectory yokla didn't see is unmeasured, never a pass. Findings name
// tools and the case's expected values; they never quote the target's
// arguments, which the results may not keep.

import { getFieldPath } from '../extract/jsonpath.ts';
import type { JsonValue } from '../extract/response.ts';
import { coreExpectations } from '../schema/cases.ts';
import type { Check, CheckFinding, CheckOutcome, ProxyCallView } from './types.ts';

const DIMENSION = 'tool-use';
const NO_PROXY = 'no model proxy data for this turn';
const UNREADABLE = "the tool calls of a model call couldn't be read";

interface Asked {
  readonly name: string;
  readonly arguments: string;
}

function unmeasured(reason: string, findings: readonly CheckFinding[] = []): CheckOutcome {
  return { applicable: true, findings, unmeasured: [{ dimension: DIMENSION, reason }] };
}

function fail(
  message: string,
  severity: CheckFinding['severity'],
  evidence: JsonValue,
): CheckFinding {
  return { dimension: DIMENSION, verdict: 'fail', severity, message, evidence };
}

/** Parsed arguments; empty text is no arguments. undefined when not valid JSON. */
function parsed(text: string): { readonly value: unknown } | undefined {
  if (text.trim() === '') return { value: {} };
  try {
    const value: unknown = JSON.parse(text);
    return { value };
  } catch {
    return undefined;
  }
}

/** Whether two JSON values are equal: numbers by value, objects key by key. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => jsonEqual(item, b[index]))
    );
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) => Object.hasOwn(b, key) && jsonEqual(Reflect.get(a, key), Reflect.get(b, key)),
    )
  );
}

/** "priceMax 500, productType \"tent\"": the expected values, from the case. */
function described(fields: Readonly<Record<string, unknown>>): string {
  return Object.entries(fields)
    .map(([path, value]) => `${path} ${JSON.stringify(value)}`)
    .join(', ');
}

/** Whether `names` appear in `trajectory` in this order, others allowed between. */
function inOrder(trajectory: readonly string[], names: readonly string[]): boolean {
  let next = 0;
  for (const name of trajectory) {
    if (name === names[next]) next += 1;
    if (next === names.length) return true;
  }
  return next === names.length;
}

function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

export const toolCalls: Check = {
  id: 'tool-calls',
  description:
    "The turn's model calls asked for the tools the case expects, with the expected arguments, in order, and no forbidden or excess calls.",
  run(context) {
    const parsedExpectation = coreExpectations.tools.safeParse(context.turn.expect['tools']);
    if (!parsedExpectation.success) {
      return { applicable: false, reason: 'the turn expects nothing of tool calls' };
    }
    const expected = parsedExpectation.data;
    const { proxy } = context.turn;
    if (proxy === undefined) return unmeasured(NO_PROXY);
    if (proxy.calls.some((call) => call.toolCalls === null)) return unmeasured(UNREADABLE);
    const asked: Asked[] = proxy.calls.flatMap((call) => call.toolCalls ?? []);
    const trajectory = asked.map((call) => call.name);
    const findings: CheckFinding[] = [];

    for (const name of expected.called ?? []) {
      if (!trajectory.includes(name)) {
        findings.push(fail(`never asked for ${name}`, 'medium', { tool: name }));
      }
    }
    for (const name of expected.notCalled ?? []) {
      const times = trajectory.filter((tool) => tool === name).length;
      if (times > 0) {
        findings.push(
          fail(`asked for ${name}, which the turn forbids (${counted(times, 'time')})`, 'high', {
            tool: name,
            times,
          }),
        );
      }
    }
    for (const [name, fields] of Object.entries(expected.args ?? {})) {
      const calls = asked.filter((call) => call.name === name);
      const matches = calls.some((call) => {
        const args = parsed(call.arguments);
        return (
          args !== undefined &&
          Object.entries(fields).every(([path, value]) =>
            jsonEqual(getFieldPath(args.value, path), value),
          )
        );
      });
      if (!matches) {
        findings.push(
          fail(
            calls.length === 0
              ? `never asked for ${name}, so no call has ${described(fields)}`
              : `no call of ${name} has ${described(fields)} (${counted(calls.length, 'call')})`,
            'high',
            { tool: name, expected: fields },
          ),
        );
      }
    }
    if (expected.order !== undefined && !inOrder(trajectory, expected.order)) {
      findings.push(
        fail(`didn't ask for ${expected.order.join(', ')} in this order`, 'medium', {
          expected: expected.order,
          asked: trajectory,
        }),
      );
    }
    if (expected.maxCalls !== undefined && asked.length > expected.maxCalls) {
      findings.push(
        fail(
          `${counted(asked.length, 'tool call')}, more than the ${String(expected.maxCalls)} allowed`,
          'medium',
          { calls: asked.length, max: expected.maxCalls },
        ),
      );
    }
    if (findings.length > 0) return { applicable: true, findings };
    return {
      applicable: true,
      findings: [
        {
          dimension: DIMENSION,
          verdict: 'pass',
          severity: 'medium',
          message:
            asked.length === 0
              ? 'no tool calls, as expected'
              : `${counted(asked.length, 'tool call')} as expected: ${trajectory.join(', ')}`,
        },
      ],
    };
  },
};

export const toolCallValid: Check = {
  id: 'tool-call-valid',
  description:
    'Every tool a model call asked for was offered by that call, with arguments that are valid JSON.',
  run(context) {
    const { proxy } = context.turn;
    const offering = (proxy?.calls ?? []).filter(
      (call): call is ProxyCallView & { offered: readonly string[] } =>
        call.offered !== null && call.offered.length > 0,
    );
    if (offering.length === 0) {
      return { applicable: false, reason: 'no model call of the turn offered tools' };
    }
    const findings: CheckFinding[] = [];
    let checked = 0;
    let unread = false;
    for (const [index, call] of offering.entries()) {
      if (call.toolCalls === null) {
        unread = true;
        continue;
      }
      for (const asked of call.toolCalls) {
        checked += 1;
        const where = `model call ${String(index + 1)} of those that offered tools`;
        if (!call.offered.includes(asked.name)) {
          findings.push(
            fail(`${where} asked for ${asked.name}, which it didn't offer`, 'high', {
              tool: asked.name,
              offered: [...call.offered],
            }),
          );
        }
        if (parsed(asked.arguments) === undefined) {
          findings.push(
            fail(`${where} asked for ${asked.name} with arguments that aren't valid JSON`, 'high', {
              tool: asked.name,
            }),
          );
        }
      }
    }
    if (unread) return unmeasured(UNREADABLE, findings);
    if (findings.length > 0) return { applicable: true, findings };
    return {
      applicable: true,
      findings: [
        {
          dimension: DIMENSION,
          verdict: 'pass',
          severity: 'high',
          message:
            checked === 0
              ? 'no tool calls'
              : `${counted(checked, 'tool call')}, each offered and with valid JSON arguments`,
        },
      ],
    };
  },
};
