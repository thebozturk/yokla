// Helpers for pack authors' tests (design §10): every check ships with
// mutation tests, and the harness asserts that each mutation was applied, so a
// mutation that silently did nothing can't make a test pass.

import type { Case } from './schema/cases.ts';
import type { CheckContext, LanguagePack, ProxyCallView, TurnView } from './checks/types.ts';
import type { Profile } from './schema/profile.ts';

/**
 * Returns `change(value)` and throws unless the result differs from `value`.
 * `change` returns a changed copy and leaves `value` alone.
 */
export function mutate<T>(value: T, change: (value: T) => T): T {
  const before = JSON.stringify(value);
  const result = change(value);
  if (JSON.stringify(result) === before) throw new Error('the mutation did not change anything');
  return result;
}

/** A turn with sensible defaults, for check tests. */
export function turnView(
  change: Partial<Omit<TurnView, 'response'>> & { response?: Partial<TurnView['response']> } = {},
): TurnView {
  const { response, ...rest } = change;
  return {
    user: 'message',
    expect: {},
    observed: undefined,
    clarifying: false,
    faults: undefined,
    unusable: undefined,
    proxy: undefined,
    ...rest,
    response: {
      status: 200,
      latencyMs: 10,
      text: '',
      route: undefined,
      id: undefined,
      evidence: {},
      ...response,
    },
  };
}

/** A model call as checks see it, for check tests: 100 input tokens, an empty prompt. */
export function proxyCall(change: Partial<ProxyCallView> = {}): ProxyCallView {
  return { inputTokens: 100, prompt: [], ...change };
}

/** `count` model calls as checks see them, for check tests. */
export function proxyCalls(count: number): ProxyCallView[] {
  return Array.from({ length: count }, () => proxyCall());
}

const MINIMAL_PROFILE = {
  version: 1,
  target: {
    name: 'test',
    adapter: 'http',
    request: { url: 'http://127.0.0.1:1/chat', method: 'POST', timeoutMs: 1_000 },
    response: { text: '$.answer' },
    session: { mode: 'client', carry: [] },
    cacheBypass: { kind: 'none' },
  },
  languages: ['tr', 'en'],
  domain: 'test',
  capabilities: [],
} satisfies Profile;

/** A check context around one turn, for check tests. */
export function checkContext(
  turn: TurnView,
  change: Partial<Omit<CheckContext, 'turn'>> & { profile?: Profile } = {},
): CheckContext {
  const testCase: Case = {
    id: 'case',
    suite: 'factual',
    language: 'tr',
    turns: [{ user: turn.user }],
    tags: [],
  };
  return {
    case: testCase,
    turnIndex: change.history?.length ?? 0,
    history: [],
    profile: MINIMAL_PROFILE,
    lang: undefined,
    languages: new Map(change.lang === undefined ? [] : [[change.lang.language, change.lang]]),
    ...change,
    turn,
  };
}

/** A language pack that finds nothing, for tests that don't depend on a language. */
export function stubLanguagePack(language: string): LanguagePack {
  return {
    language,
    fold: (text) => text.toLowerCase(),
    findMoney: () => [],
    findDurations: () => [],
    formatMoney: (amount, currency) => `${String(amount)} ${currency}`,
    phrases: { refusal: [], inability: [], absence: [], alternative: [], free: [], deflection: [] },
    commonWords: [],
  };
}
