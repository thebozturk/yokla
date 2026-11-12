# Cases

A case is a conversation: one or more turns, each with the user's message and
what the answer must satisfy. Cases live in YAML or JSON files, usually under
`cases/`. `yokla run --cases` takes a file or a directory and may be repeated.
The [JSON Schema](../../packages/cli/schemas/cases.v1.schema.json) gives
every field; `yokla schema cases` prints it.

```yaml
version: 1
cases:
  - id: tent-under-budget
    suite: factual
    language: en
    turns:
      - user: Show me a tent for four under $250.
        expect:
          evidence: { products: { min: 1 } }
          filters: { maxPrice: 250 }
          productType: outdoor/camping/tent
          answerable: true
      - user: Add the cheapest one to my cart.
        expect:
          deadlineMs: 8000
          budget: { costUsd: 0.01, modelCalls: 4 }
```

## The case

| Field | Meaning |
|---|---|
| `id` | Unique, in lowercase letters, digits, `-` and `.`. Results, the baseline and the gate refer to it. |
| `title` | Optional, for people. |
| `suite` | `quality`, `factual`, `redteam`, `robustness`, `perf` or `resilience`. The gate judges each suite with its own thresholds. |
| `language` | `tr` or `en`. The language pack of that language reads the answer. |
| `turns` | The conversation, in order. |
| `samples` | How many times to run the case. Without it, `yokla run --samples` decides, and that defaults to 1. |
| `checks` | Run only these checks. By default every check that applies runs. |
| `knownGap` | `{ reason, issue? }`: a known failure. A failing case is then `known-gap`, not `fail`. Once it passes, it is `gap-closed`, and the gate asks for the marker to be removed. |
| `tags` | Free labels. |
| `provenance` | Where the case comes from and whether a person approved it (ADR-0004). |

Each sample opens a new session and bypasses the target's cache (see the
[profile](profile.md)).

## The turn

| Field | Meaning |
|---|---|
| `user` | The user's message, sent as `{{message}}`. |
| `request.body` | Merged into the profile's request body for this turn only: objects merge key by key, any other value replaces. |
| `request.headers` | Extra headers for this turn only. |
| `faults` | Provider faults the model proxy injects into this turn (below). |
| `expect` | What the answer must satisfy (below). |

## Expectations

Each expectation enables the check that judges it. A turn without
expectations is still judged by the checks that need none, such as
`price-grounded` and `stock-claim`. See [checks](checks.md) for what each
check does and when it doesn't apply.

| Expectation | Meaning | Judged by |
|---|---|---|
| `route` | The route, or one of the routes, that may answer. Needs `response.route` in the profile. | `route-expected` |
| `answer.contains`, `answer.notContains` | Phrases the answer must or must not contain, after the language pack's folding. | `answer-text` |
| `evidence.<collection>` | `min` and `max` item counts, and `includes`: item ids that must be returned. | `evidence-count` |
| `deadlineMs` | The answer must arrive within this many milliseconds. | `answered-within-deadline` |
| `budget.costUsd`, `budget.modelCalls` | The most the turn's model calls may cost, and how many there may be. Needs the model proxy. | `cost-budget` |
| `budget.inputTokens` | The most input tokens any one model call of the turn may send. | `prompt-budget` |
| `notSentToModel` | Seeded values, such as fake personal data, that must appear in no message of the turn's model calls. | `pii-in-prompt` |
| `filters` | The filters the user asked for: `maxPrice`, `minPrice`, and `attributes` (evidence field → value). | `filter-honoured-or-disclosed` |
| `productType` | The product type or types asked for, as catalog types. A type under one of them, by `typeSeparator`, matches. | `type-matched-or-disclosed` |
| `absentType` | The type asked for is not in the catalog. | `absence-correct` |
| `answerable` | `true`: the request can be answered, so a refusal is over-refusal. `false`: it must be refused. | `over-refusal`, `deflection` |
| `policyTopic` | The turn asks about this policy, so every concrete claim in the answer is about it. | `policy-claim` |

## Provider faults

With the model proxy, a turn can make the target's provider fail on purpose
(ADR-0013). The proxy applies a fault only to that turn's model calls.

```yaml
turns:
  - user: Do you have a sleeping bag for winter?
    faults:
      - fault: { kind: status, status: 503 }
        calls: [1]                 # only the turn's first model call
    expect:
      deadlineMs: 10000
```

| `fault.kind` | Effect |
|---|---|
| `status` | Answer `429`, `500` or `503` without calling the provider, optionally with `retryAfterS`. |
| `latency` | Delay the call by `ms`, plus up to `jitterMs`. The jitter is drawn from the case id, the sample and the turn, so a run repeats it; each sample gets its own draw (ADR-0017). |
| `timeout` | Hold the connection without an answer for `holdMs` (default 120000). |
| `malformed-json` | Break the provider's JSON answer. |
| `empty-content` | Empty the answer's content. |
| `truncated-stream` | Cut a streamed answer short. |
| `invalid-tool-call` | Make a tool call's arguments invalid. |

- **Which calls:** `calls` lists the turn's calls by number, from 1. The default
  is every call. `upstream` limits a fault to one upstream. The first plan
  that matches a call applies.
- **Costs:** `status` and `timeout` faults make no provider call and cost
  nothing. The other faults change the real answer, whose usage is still
  recorded.
- **Judging:** `graceful-under-fault` judges every turn with faults. A turn
  without a usable answer, such as an error status or no answer, is judged
  only by the fault checks, since the others need an answer.
- **Requirement:** faults need a model proxy. A case with faults is refused
  up front without one.

## Statuses

Each case ends with one status:

| Status | Meaning |
|---|---|
| `pass` | Every deciding dimension passed. |
| `fail` | A deciding dimension failed. |
| `unmeasured` | Nothing failed, but a deciding dimension couldn't be measured, or no check applied. Never a pass. |
| `error` | A turn couldn't be run or read, for example because the target was down. |
| `known-gap` | It failed, and the case is marked `knownGap`. |
| `gap-closed` | It passed, and the case is still marked `knownGap`. |

With several samples, each dimension is judged across them: most fail when any
sample fails, and refusal correctness goes by the majority. Results also flag
a case as `unstable` when its samples disagree. See design §13.
