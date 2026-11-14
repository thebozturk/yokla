# 0033. Where a failure arose: the origin of the value a finding names

Status: Accepted · Date: 2026-11-15

## Context

A failing finding says what is wrong: "1.169,10 TL is not the price of any
returned product". It doesn't say where the wrong amount came from, and the
fix depends on it:

- **It was in what the model was sent.** A stale price in the system prompt,
  a wrong product from retrieval, an old campaign in a tool result. The fix
  is in the data or the retrieval, and a better model won't help.
- **The model wrote it.** No message the model got had it. The fix is in
  the prompt, the model, or a guard on its output.
- **The app wrote it.** The model's answer had the right amount, or none,
  and the app changed or added it afterwards. The fix is in the app's code.

The model proxy already sees the first of these. While a recording is open,
it hands the runner the text of every message each call sent (ADR-0015) and
the tool results the model saw (ADR-0026). It doesn't keep the text the
model answered. So today a person has to read prompts by hand to tell the
three apart, and with `prompts.store: sizes`, the default, the text is gone
once the run ends.

The debugging track in design §20 starts here (D1).

## Decision

### What the proxy reads

- **The model's answer text.** For every call, while a recording is open,
  the proxy captures the text the model answered.
  - Chat completions: the message's `content`.
  - The Responses API: the text of its `message` output items.
  - Anthropic: its `text` blocks.
  - From a JSON answer and from an event stream, with a streamed answer's
    pieces joined.
  - Tool calls stay as ADR-0025 reads them, apart from the text.
  - An answer the proxy can't read gives the call a `null` output.
- **Kept as the prompt is.** The text stays in memory and goes to the runner
  with the prompt. `prompts.store` sets what the results and the records file
  keep of it, as for a prompt message (ADR-0015). results.v1 gains it as an
  optional `output` on each attributed call.

### What a finding names

- **A subject.** A check can give a failing finding a `subject`: the value
  the failure is about.

  | Kind | Fields | Given by |
  |---|---|---|
  | `money` | `amount`, `currency` (optional) | `price-grounded`; `policy-claim`, for a fee |
  | `duration` | `amount`, `unit` | `policy-claim` |
  | `text` | `text` | `answer-text`, for a `notContains` phrase or the span a `notMatches` pattern matched |

  - The value always comes from the answer, so a subject quotes no prompt
    text.
  - Other checks give no subject yet. Their findings carry no origin.

### How the origin is worked out

- **Where.** Core works it out after a check runs, for each failing finding
  with a subject, from the turn's model calls. It is one mechanism for every
  check, and it stays pure.
- **The stages, in order.**

  | `stage` | When |
  |---|---|
  | `input` | the value is in a message one of the turn's calls sent |
  | `model` | it is in no message sent, and in the text a call answered |
  | `app` | it is in no message sent and in no answer, and every call's messages and answer were read; or the turn made no model call |
  | `unknown` | no proxy data for the turn, or a call whose messages or answer the proxy couldn't read |

  - `input` names the first call, in the turn's order, and the message's
    role, and its tool for a tool result (ADR-0026).
  - `model` names the first call whose answer has it.
  - `unknown` gives its reason. It is never replaced by a guess.
  - A turn with no model calls is a measurement, as for the inspection
    checks (ADR-0015): the app wrote the answer itself.
- **How a value is found in a text.**
  - **`money`.** An amount the language packs find in the text, equal to
    the cent, with the same currency when both name one. The answer's own
    language pack is tried first, then the other loaded packs, because a
    system prompt is often in another language than the answer.
  - **A number in JSON.** In a message or an answer that reads as JSON,
    whole or from its first `{` to its last `}` as in ADR-0026, a number
    equal to a `money` amount also counts. The origin says so, as
    `match: number`, because a bare number is weaker evidence than an
    amount with its currency.
  - **`duration`.** A duration the language packs find, with the same
    amount and unit.
  - **`text`.** Folded by the answer's language pack, with whitespace
    collapsed and JSON string escapes decoded, as `untrusted-in-system`
    matches (ADR-0015).
- **What it never changes.** An origin explains a finding. It never changes
  a verdict, a case status, an aggregation or the gate.

### What the results and the reports show

- **results.v1.** A finding gains two optional fields: `subject`, and
  `origin` as `{stage, call?, role?, tool?, match?, reason?}`. Neither quotes
  prompt or answer text, so both are stored whatever `prompts.store` says.
- **Reports.** The terminal summary, the HTML report and the JUnit message
  add the origin after the finding's message: "origin: what the model was
  sent (call 2, tool search_products)", "origin: the model (call 1)",
  "origin: the app".

### The demo-shop

Two new defects, each with the model over HTTP, sit next to
`fabricated-price`:

- **`stale-price-in-prompt`:** the writer's prompt gives the first product a
  price 10 % above the catalog's, and the model repeats it. The origin is
  `input`.
- **`price-rewritten`:** the model writes the right prices, and the app
  lowers the first one by 10 % before it answers. The origin is `app`.
- **`fabricated-price`,** with the model over HTTP, is written by the fake
  provider. Its origin is `model`.
- Each of the three fails only `price-grounded`, as `fabricated-price` does
  today. The acceptance run checks the origin of each.
- In process, without the proxy, the same defects have the origin `unknown`.

## Consequences

- **A failure points to its fix.** Data, model or app, read from what the
  model was given and what it said, at no model cost.
- **The proxy holds more in memory.** It now keeps each call's answer text,
  as it keeps its messages, for an open recording only.
- **Stored text follows the profile.** With `prompts.store: sizes`, only the
  answer's length is kept, as for a prompt message. The origin itself is
  kept in every mode, because it holds names and positions only.
- **An origin is as good as what the proxy sees.** Targets it can't see,
  and calls read from OpenTelemetry spans without their text (ADR-0029),
  give `unknown`.
- **Matching across languages can mislead.** A number that means something
  else in a tool result can make a model's invention look like `input`. The
  `match: number` label shows where that can happen, and an amount with its
  currency is preferred.
- **Checks without a subject are unchanged.** A later ADR can give
  `stock-claim`, `filter-honoured-or-disclosed` and others a subject.

## Alternatives considered

- **Working out the origin in the report, from the stored records.** With
  the default `prompts.store: sizes` the text is gone by then, and storing
  full prompts by default would break ADR-0015. Rejected: the origin is
  worked out while the text is still in memory.
- **Asking a model where the failure came from.** It costs money, can't be
  calibrated per finding, and contradicts deterministic checks first
  (ADR-0005). Rejected.
- **Each check working out its own origin.** Every check would repeat the
  same search, each a little differently. Rejected: checks name a subject,
  and core finds it.
- **Diffing the model's last answer against the app's answer.** That shows
  everything the app changed, not only the value a finding is about, and
  apps reformat answers freely. Deferred, as a complement.
- **Matching bare numbers in plain text.** "3" in "3 items" would match a
  price of 3. Rejected, as bare numbers are not money (design §17); only a
  number in JSON counts, and it is labelled.
