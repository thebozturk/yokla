// Domain-neutral checks for the core expectations every case may use:
// route, answer and evidence (design §10). They run for every target.

import { coreExpectations } from '../schema/cases.ts';
import { findPhrases } from '../text/phrases.ts';
import { fold } from './fold.ts';
import { piiInPrompt, promptBudget, promptLeak, untrustedInSystem } from './inspection.ts';
import type { Check, CheckFinding } from './types.ts';

export const routeExpected: Check = {
  id: 'route-expected',
  description: 'The turn was answered by one of the expected routes.',
  run(context) {
    const parsed = coreExpectations.route.safeParse(context.turn.expect['route']);
    if (!parsed.success) return { applicable: false, reason: 'the turn expects no route' };
    const expected = typeof parsed.data === 'string' ? [parsed.data] : parsed.data;
    const actual = context.turn.response.route;
    if (actual === undefined) {
      return {
        applicable: false,
        reason: 'the response has no route; map response.route in the profile',
      };
    }
    const ok = expected.includes(actual);
    return {
      applicable: true,
      findings: [
        {
          dimension: 'routing',
          verdict: ok ? 'pass' : 'fail',
          severity: 'medium',
          message: ok
            ? `answered by ${actual}`
            : `answered by ${actual}, expected ${expected.join(' or ')}`,
          evidence: { expected, actual },
        },
      ],
    };
  },
};

export const answerText: Check = {
  id: 'answer-text',
  description: "The answer contains, or doesn't contain, the expected phrases.",
  run(context) {
    const parsed = coreExpectations.answer.safeParse(context.turn.expect['answer']);
    if (!parsed.success)
      return { applicable: false, reason: 'the turn expects nothing of the text' };
    const text = fold(context, context.turn.response.text);
    const findings: CheckFinding[] = [];
    for (const phrase of parsed.data.contains ?? []) {
      const found = findPhrases(text, [fold(context, phrase)]).length > 0;
      findings.push({
        dimension: 'answer-content',
        verdict: found ? 'pass' : 'fail',
        severity: 'medium',
        message: found ? `contains "${phrase}"` : `doesn't contain "${phrase}"`,
      });
    }
    for (const phrase of parsed.data.notContains ?? []) {
      const found = findPhrases(text, [fold(context, phrase)]).length > 0;
      findings.push({
        dimension: 'answer-content',
        verdict: found ? 'fail' : 'pass',
        severity: 'medium',
        message: found ? `contains "${phrase}", which it must not` : `doesn't contain "${phrase}"`,
      });
    }
    if (parsed.data.notEmpty === true) {
      // A letter or a digit in any script: punctuation and spaces alone say nothing.
      const said = /[\p{L}\p{N}]/u.test(context.turn.response.text);
      findings.push({
        dimension: 'answer-content',
        verdict: said ? 'pass' : 'fail',
        severity: 'medium',
        message: said ? 'the answer is not empty' : 'the answer is empty',
      });
    }
    if (findings.length === 0) return { applicable: false, reason: 'no phrases to look for' };
    return { applicable: true, findings };
  },
};

/** A turn that lists allowed statuses is judged on its status, not stopped by it (ADR-0018). */
export const statusAllowed: Check = {
  id: 'status-allowed',
  description: 'The target answered with a 2xx status, or one the turn allows.',
  run(context) {
    const parsed = coreExpectations.allowStatus.safeParse(context.turn.expect['allowStatus']);
    if (!parsed.success) return { applicable: false, reason: 'the turn allows no other status' };
    const { status } = context.turn.response;
    const ok = (status >= 200 && status <= 299) || parsed.data.includes(status);
    return {
      applicable: true,
      findings: [
        {
          dimension: 'robustness',
          verdict: ok ? 'pass' : 'fail',
          severity: 'high',
          message: ok
            ? `answered with ${String(status)}`
            : `answered with ${String(status)}, which is neither 2xx nor one of ${parsed.data.join(', ')}`,
          evidence: { status, allowed: parsed.data },
        },
      ],
    };
  },
};

export const evidenceCount: Check = {
  id: 'evidence-count',
  description:
    'Evidence collections have the expected number of items and include the expected ids.',
  run(context) {
    const parsed = coreExpectations.evidence.safeParse(context.turn.expect['evidence']);
    if (!parsed.success)
      return { applicable: false, reason: 'the turn expects nothing of the evidence' };
    if (context.turn.clarifying) {
      return { applicable: false, reason: 'the target asked a clarifying question' };
    }
    const findings: CheckFinding[] = [];
    for (const [name, expectation] of Object.entries(parsed.data)) {
      const items = context.turn.response.evidence[name];
      if (items === undefined) {
        return { applicable: false, reason: `the profile maps no evidence collection "${name}"` };
      }
      const count = items.length;
      if (expectation.min !== undefined) {
        findings.push({
          dimension: 'evidence',
          verdict: count >= expectation.min ? 'pass' : 'fail',
          severity: 'medium',
          message: `${name}: ${String(count)} items, expected at least ${String(expectation.min)}`,
        });
      }
      if (expectation.max !== undefined) {
        findings.push({
          dimension: 'evidence',
          verdict: count <= expectation.max ? 'pass' : 'fail',
          severity: 'medium',
          message: `${name}: ${String(count)} items, expected at most ${String(expectation.max)}`,
        });
      }
      const ids = new Set(items.map((item) => item['id']).filter((id) => typeof id === 'string'));
      for (const id of expectation.includes ?? []) {
        findings.push({
          dimension: 'evidence',
          verdict: ids.has(id) ? 'pass' : 'fail',
          severity: 'medium',
          message: ids.has(id) ? `${name} includes ${id}` : `${name} doesn't include ${id}`,
        });
      }
    }
    if (findings.length === 0) return { applicable: false, reason: 'no evidence expectations' };
    return { applicable: true, findings };
  },
};

/** The checks that run for every case, whatever the domain. */
/** Under injected provider faults, the target still gives an answer (ADR-0013). */
export const gracefulUnderFault: Check = {
  id: 'graceful-under-fault',
  description: 'Under injected provider faults, the target still gives a usable answer.',
  run(context) {
    const { faults } = context.turn;
    if (faults === undefined) return { applicable: false, reason: 'the turn injects no faults' };
    const ok = faults.failure === undefined;
    return {
      applicable: true,
      findings: [
        {
          dimension: 'resilience',
          verdict: ok ? 'pass' : 'fail',
          severity: 'high',
          message: ok
            ? 'answered despite the injected faults'
            : `gave no usable answer under the injected faults: ${faults.failure ?? ''}`,
        },
      ],
    };
  },
};

export const answeredWithinDeadline: Check = {
  id: 'answered-within-deadline',
  description: "The answer arrived within the turn's deadlineMs.",
  run(context) {
    const parsed = coreExpectations.deadlineMs.safeParse(context.turn.expect['deadlineMs']);
    if (!parsed.success) return { applicable: false, reason: 'the turn has no deadline' };
    const took = context.turn.response.latencyMs;
    const ok = took <= parsed.data;
    return {
      applicable: true,
      findings: [
        {
          dimension: 'deadline',
          verdict: ok ? 'pass' : 'fail',
          severity: 'high',
          message: `answered in ${String(Math.round(took))} ms, deadline ${String(parsed.data)} ms`,
          evidence: { latencyMs: took, deadlineMs: parsed.data },
        },
      ],
    };
  },
};

/** The turn's model calls stay within its budget; without the data to judge it, unmeasured (ADR-0014). */
export const costBudget: Check = {
  id: 'cost-budget',
  description: "The turn's model calls stay within its budget: their cost and their number.",
  run(context) {
    const parsed = coreExpectations.budget.safeParse(context.turn.expect['budget']);
    if (!parsed.success) return { applicable: false, reason: 'the turn has no budget' };
    const { costUsd, modelCalls } = parsed.data;
    if (costUsd === undefined && modelCalls === undefined) {
      return { applicable: false, reason: 'the budget sets no cost and no call count' };
    }
    const { proxy } = context.turn;
    if (proxy === undefined) {
      return {
        applicable: true,
        findings: [],
        unmeasured: [{ dimension: 'cost', reason: 'no model proxy data for this turn' }],
      };
    }
    const findings: CheckFinding[] = [];
    if (modelCalls !== undefined) {
      const calls = proxy.calls.length;
      findings.push({
        dimension: 'cost',
        verdict: calls <= modelCalls ? 'pass' : 'fail',
        severity: 'medium',
        message: `${String(calls)} model calls, budget ${String(modelCalls)}`,
      });
    }
    if (costUsd !== undefined && proxy.costUsd === null) {
      return {
        applicable: true,
        findings,
        unmeasured: [{ dimension: 'cost', reason: 'a model call of the turn has no cost' }],
      };
    }
    if (costUsd !== undefined && proxy.costUsd !== null) {
      findings.push({
        dimension: 'cost',
        verdict: proxy.costUsd <= costUsd ? 'pass' : 'fail',
        severity: 'medium',
        message: `cost ${String(proxy.costUsd)} USD, budget ${String(costUsd)} USD`,
        evidence: { costUsd: proxy.costUsd, budgetUsd: costUsd },
      });
    }
    return { applicable: true, findings };
  },
};

/**
 * The checks that judge a turn without a usable answer, under faults (ADR-0013)
 * or with a non-2xx status the turn allows (ADR-0018); the others need an answer.
 */
export const UNANSWERED_JUDGES: ReadonlySet<string> = new Set([
  gracefulUnderFault.id,
  answeredWithinDeadline.id,
  statusAllowed.id,
]);

export const CORE_CHECKS: readonly Check[] = [
  routeExpected,
  answerText,
  evidenceCount,
  gracefulUnderFault,
  answeredWithinDeadline,
  statusAllowed,
  costBudget,
  promptBudget,
  promptLeak,
  untrustedInSystem,
  piiInPrompt,
];
