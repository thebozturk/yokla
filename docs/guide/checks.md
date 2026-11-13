# Checks

Every check is deterministic: no model is called to judge an answer
(ADR-0005). A check runs on each turn and reports one of three outcomes:

- **Not applicable,** with a reason, when its input is absent. A check never
  passes a turn it couldn't judge.
- **Findings,** each a `pass` or `fail` on a dimension, such as `fabrication`.
- **Unmeasured,** for a dimension the check applies to but can't measure,
  such as a cost budget without proxy data. Unmeasured is never a pass.

The results say which checks applied, with what result, and why the others
didn't. A case runs every check unless its `checks` field lists some.

## Core checks

These work for any assistant.

| Check | Dimension | Applies when | Judges |
|---|---|---|---|
| `route-expected` | routing | the turn expects a `route` | The turn was answered by an expected route. Needs `response.route` in the profile; without it, the result says to map it. |
| `answer-text` | answer-content | the turn has `answer.contains`, `answer.notContains` or `answer.notEmpty` | The answer contains, or doesn't contain, each phrase after folding; with `notEmpty`, it has a letter or a digit. |
| `evidence-count` | evidence | the turn expects `evidence` | Each collection has between `min` and `max` items and includes the listed ids. Not applicable when the target asked a clarifying question, or when the profile doesn't map the collection. |
| `graceful-under-fault` | resilience | the turn injects faults | The target still gives a usable answer: a non-2xx status, an unreadable answer or no answer at all fails. |
| `answered-within-deadline` | deadline | the turn has `deadlineMs` | The full answer arrived in time. |
| `status-allowed` | robustness | the turn has `allowStatus` | The target handled the turn: a 2xx answer yokla reads in full, or a listed status. Another status, a stream cut before its done event, a body that isn't JSON, an answer without its text or no answer at all fails, and the finding says which (ADR-0019). A target that mishandles an edge case then fails the case instead of making the run unjudgeable. |
| `language-match` | language | the turn has `language`, and at least two language packs are loaded | The answer is in that language. Each pack's most common words are counted in the answer; the language whose words make up at least a tenth of it, and twice the share of any other, is its language. Fewer than five words, or no clear lead, is unmeasured. |
| `cost-budget` | cost | the turn's `budget` sets `costUsd` or `modelCalls` | The turn's model calls stay within the budget. Unmeasured without proxy data, or when a call of the turn has no cost. |

A turn without a usable answer, under faults or with a non-2xx status it
allows, is judged only by `graceful-under-fault`, `answered-within-deadline`
and `status-allowed`: the other checks need an answer.

### Prompt inspection (ADR-0015)

These read the model calls the proxy captured for the turn.

| Check | Dimension | Applies when | Judges |
|---|---|---|---|
| `prompt-budget` | prompt-size | the turn's `budget` sets `inputTokens` | No model call of the turn sent more input tokens. A call without an input count makes it unmeasured, unless a counted call is already over. |
| `prompt-leak` | leakage | the profile sets `modelProxy.inspect.canary` | The answer doesn't contain the canary, ignoring case. It passes only when the canary was in a system message of the turn. A canary that reached no system prompt in the whole run is reported as a run issue. |
| `untrusted-in-system` | untrusted-content | the profile names `modelProxy.inspect.untrusted` fields | No retrieved value of three words or more, from those evidence fields, is in a system message. Matching folds, collapses whitespace and decodes JSON escapes. |
| `pii-in-prompt` | privacy | the turn lists `notSentToModel` values | None of them is in any message of the turn's model calls, in any role. Matching folds and ignores whitespace, dots, dashes and parentheses. |

Without proxy data, or when a prompt couldn't be read, an inspection is
unmeasured; a failure found in the readable prompts still fails. Findings name
the call, the role and the value, never the prompt text.

## E-commerce checks

These read the `products` evidence collection and the profile's `ecommerce`
section. Each needs the language pack of the case's language.

| Check | Dimension | Applies when | Judges |
|---|---|---|---|
| `price-grounded` | fabrication | the answer mentions money, and a product returned in the conversation has a price | Every amount is the price of a product returned in this turn or an earlier one, a declared campaign amount, an amount in a policy source, an amount from a price source, a returned price times a quantity stated in the same sentence ("$356 for four", ADR-0021), a total of two or more of the answer's own grounded amounts ("takes the list to $639.50", ADR-0022), or an amount the user wrote. The user's amounts are never parts of a total. |
| `stock-claim` | fabrication | products were returned, and stock or availability is known from the response or the catalog | No availability claim about a product whose stock is unknown; a claim about known stock matches the quantity, or else `inStock`. When both are known and disagree, the quantity decides. |
| `policy-claim` | fabrication | the profile lists policies, and the answer names a policy topic or the turn sets `policyTopic` | A concrete claim (a duration, "free", an amount) in a sentence about a topic is in that topic's source. A topic with `source: none`, or a `neverFabricate` topic the profile leaves out, can back no claim. A source only in another language isn't used. |
| `no-duplicates` | duplicates | products with ids were returned | Each product is returned once. |
| `filter-honoured-or-disclosed` | filter-honesty | the turn has `filters` and products were returned | The products satisfy the filters, or the answer discloses each relaxed one. |
| `type-matched-or-disclosed` | filter-honesty | the turn has `productType`, and a returned product's type is known | The products are of the type, or a type under it, or the answer says it shows other types. Not applicable after a clarifying question. |
| `absence-correct` | absence | the turn has `absentType` | The answer states the absence and presents other products as alternatives, not as the type asked for. Not applicable after a clarifying question. |
| `over-refusal` | over-refusal, refusal | the turn sets `answerable` | An answerable turn isn't refused; a turn marked not answerable is. A refusal is the language pack's wording or one of the profile's `refusal.canonical` sentences. |
| `deflection` | deflection | the turn is answerable | The answer does more than send the user to customer service. Advisory: reported, never decides a case. |

The detectors are narrow: they match concrete claims, such as an amount or a
duration, not bare words. A sentence such as "I can't verify the shipping
terms" makes no claim.

## Aggregation

A case's status comes from its dimensions, each judged across the samples:

- **Worst of N,** the default: one failing sample fails the dimension.
- **Majority of N:** `refusal` fails only when most samples fail.
- **Advisory:** `deflection` is reported but never decides the case.

A dimension measured in one sample but not in another is unmeasured. Results
add Wilson intervals with several samples, and mark a case `unstable` when its
samples disagree. See [cases](cases.md#statuses) for the statuses, and
design §13 for the details.
