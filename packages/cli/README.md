<div align="center">

# yokla

**End-to-end tests for conversational AI assistants:<br/>
grounded in your data, judged deterministically, run on your machine.**

[![npm](https://img.shields.io/npm/v/yokla)](https://www.npmjs.com/package/yokla)
[![CI](https://github.com/thebozturk/yokla/actions/workflows/ci.yml/badge.svg)](https://github.com/thebozturk/yokla/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/thebozturk/yokla/blob/main/LICENSE)
![Node.js 24+](https://img.shields.io/badge/node-%3E%3D24-brightgreen)

[Quick start](https://github.com/thebozturk/yokla#quick-start) · [How it works](https://github.com/thebozturk/yokla#how-it-works) · [The workflow](https://github.com/thebozturk/yokla#the-workflow) · [Guide](https://github.com/thebozturk/yokla/blob/main/docs/guide/README.md) · [Changelog](https://github.com/thebozturk/yokla/blob/main/CHANGELOG.md)

</div>

> *yokla* (Turkish): to probe, to check by touch, as in *nabzını yoklamak*,
> "to take someone's pulse".

Your assistant says a tent costs 809,55 TL. Does any tent cost that? yokla
asks your assistant the questions your customers ask, over the same API
they use. Then it checks every answer against your own catalog, prices,
stock and policies. It also watches the model calls behind each answer, with
their cost, their prompts and the tools they call. And it tells you where a
wrong value came from.

- **Expectations come from your data, not from a model's opinion.** A price
  is right when your catalog says so. The checks are deterministic, so the
  same answer gets the same verdict every time, at no model cost.
- **It tests the assistant you ship,** from the outside, over HTTP or a
  WebSocket. No SDK and no code change: a profile maps your API.
- **It sees inside, too.** Point your app's model client at `yokla proxy`.
  Every turn then shows its model calls, tokens, cost, prompts and tool
  calls, and a turn can break the provider on purpose.
- **Nothing leaves your machine.** No telemetry, no account, no cloud.

**Status: v0.5.** Turkish and English are first-class. The e-commerce pack is
the first domain pack.

## Quick start

With Node.js 24 or later, and your assistant running:

```sh
npx yokla init --url http://localhost:3000/v1/chat
npx yokla run
npx yokla gate --results runs/<run id>.json
```

- **`init`** sends your assistant one message and works out where the answer
  is in its JSON or event stream. It writes `yokla.profile.yaml` and starter
  cases that suit any assistant: a greeting, an out-of-scope question, a
  basic prompt injection, personal data, an empty and a very long message, a
  switch of language and a deadline. Read both files, and approve the cases
  you agree with. yokla makes no model call to do this.
- **`run`** runs the cases and writes the results.
- **`gate`** decides the build: `0` passed, `1` broken, `2` the run can't be
  judged.

With your assistant's repository at hand, `npx yokla analyze --dir <repo>
--url <chat url>` proposes more of the profile: your catalog and its fields,
your policies' sources, and where the products are in an answer, found by
matching its values to your catalog's. Each entry says where it came from,
and nothing runs until you approve it. It makes no model call either. It
reads your OpenAPI contract too, and proposes it only where your target's
answers keep it. With a model you configure, it also reads your docs and
code for your rate limits, your cache bypass and your refusals, keeps only
the values it can see in the line it quotes, and prints what that will cost
first.

## What a failure looks like

The demo-shop is a small outdoor-gear assistant in this repository, with
seeded defects. With its `fabricated-price` defect on, it quotes prices no
product has:

```text
18 cases: pass 6, fail 12
  fail  tents-tr               fabrication 1/1: "809,55 TL" is not the price of any returned product, a campaign or an amount the user wrote; origin: unknown (no model proxy data for this turn)
  fail  black-backpack-en      fabrication 1/1: "TRY 584.91" is not the price of any returned product, a campaign or an amount the user wrote; origin: unknown (no model proxy data for this turn)
  fail  hammock-en             fabrication 1/1: "TRY 809.55" is not the price of any returned product, a campaign or an amount the user wrote; origin: unknown (no model proxy data for this turn)
  ...
```

```text
$ yokla gate --results runs/<run id>.json
gate: broken
  factual: 10 failing cases, 0 allowed: tents-tr, tents-under-1000-tr, ...
  quality: 2 failing cases, 0 allowed: stoves-tr, cheaper-follow-up-en
```

The origin is unknown here because this run had no model proxy. With the
proxy, the same finding says where the price first appeared: in what the model was sent (your data or prompt), in the model's
answer, or only in your app's code after the model call.

## What yokla checks

**Answers against your data**
- Prices, including a price times a quantity and a total of the answer's own
  amounts. Stock claims, policy claims (returns, shipping, warranty),
  filters, product types, duplicates, absent products and over-refusal.
- Products are joined to your catalog snapshot, and an amount may also come
  from an order history or another source you name.

**The model calls behind each answer**
- Calls, tokens, cost and latency per turn, reconciled with the provider's
  own records. OpenAI-compatible APIs, Anthropic, Gemini (AI Studio and
  Vertex AI) and the Vercel AI SDK's gateway are supported, and so are calls
  the app makes after answering.
- The tools the model offers and calls: which ones must and must not be
  called, with what arguments, in what order and how often.
- The prompts: a leaked system prompt, retrieved content in the system
  message, personal data that should never reach the model, and prompts over
  budget. Results keep only message sizes unless you ask for more.
- An app whose model client can't be pointed at the proxy can show its calls
  as OpenTelemetry spans instead.

**Behaviour under failure**
- A turn can declare provider faults: `429`, `500` or `503` errors, latency,
  timeouts, malformed JSON, empty answers and truncated streams. yokla judges
  how your assistant answers under them.

**Conversations**
- Multi-turn cases with sessions, and values carried from turn to turn.
- A simulated customer with a persona and a goal, played by a model you
  choose, local or hosted. The deterministic checks judge every answer, and
  the goal counts as reached only when the answer shows it. Replies are
  cached, so a rerun repeats the conversation.
- **Messages as users write them.** `yokla run --transform` sends your cases
  without diacritics, in lower case, without punctuation, or with a typo
  that repeats from run to run, and `yokla compare --expect-same` shows any
  verdict that moved. With a model you configure, it also paraphrases them,
  or mixes Turkish and English as shoppers do, keeping every amount and
  value your checks look for.

**Red teaming**
- **`yokla generate --redteam`** writes attack cases from your catalog and
  profile, in Turkish and English, for a person to approve: prompt
  injection and system-prompt extraction, price manipulation and promises
  no policy gives, another customer's order and personal data, card
  numbers, injection through tool descriptions, tool arguments and memory,
  order fraud, a role's forbidden tools, and restrictions on age, region
  and quantity. Deterministic checks judge each one, by a canary or a value
  from your data.
- **`yokla run --strategy`** sends the attacks encoded or wrapped, and
  **`--attacker`** has a model you choose adapt them: turn by turn, in many
  attempts, as variants of variants, or in your profile's other language.
- **Findings map to frameworks:** OWASP LLM and Agentic, MITRE ATLAS, NIST
  AI RMF, ISO/IEC 42001, GDPR, KVKK and the EU AI Act, with a risk score
  per attack kind. The mapping is yokla's, not a compliance assessment.
- **A calibrated judge** decides what no rule can, such as unsafe advice,
  bias or imitation. It must grade its calibration right in every run, and
  gates nothing until you list a dimension.

**Your own rules**
- Regular expressions on the answer, a JSON Schema on the response, and
  similarity to reference answers.
- A rule only your team knows can be a check of your own: a small module
  your configuration names.

**From a finding to its fix**
- **Where a value came from:** what the model was sent, the model, or the
  app.
- **`yokla shrink`** cuts a failing case down to the fewest turns that still
  fail the same check. It reports a flaky failure as flaky.
- **`yokla run --stop-early`** stops a case's samples once its failure is
  settled.
- **`yokla run --record` and `--replay`** keep a run's model calls in a
  cassette and answer them from it, so a suite repeats with no model cost. A
  fault can make the model say something else, to see what the app does.
- **`yokla run --swap-model`** tries another model under your cases, with
  the app unchanged, and **`yokla compare`** names the cheapest run that
  still passes the gate.
- **Indirect injection without a copy of your data:** the proxy writes an
  instruction into a tool result before the model sees it, and
  `injection-canary` checks the answer didn't follow it. A run that reverses
  a tool's results checks that no verdict moves.
- **`yokla mcp`** gives a coding agent these as tools, over the Model Context
  Protocol: run the cases, explain a failure, shrink it, and verify a fix
  against it and its neighbours, within a cost cap you set.
- **`yokla explore`** searches for the routes, tools, argument shapes and
  fault states your cases never reach. It writes the conversations that reach
  one, or fail a check, as proposed cases, such as a cart of two products
  whose total is wrong.
- **`yokla generate`** writes cases from your catalog before anything is
  sent: a lookup that must show the catalog's price, a type you don't sell,
  an empty price band, an attribute filter, a comparison, a refinement, a
  cheaper follow-up and a product whose stock is unknown. Every one is
  proposed, for you to approve.

**Cost and CI**
- Per-turn and per-suite budgets for cost and latency. `yokla plan`
  estimates a run's cost before it runs, and `--max-cost` caps it.
- `yokla gate` checks thresholds per suite, and regressions against a
  baseline small enough to commit.
- A terminal summary, JUnit XML, and an offline HTML report that shows each
  answer next to its findings.

## A case

Cases are YAML (or JSON), with a JSON Schema for your editor:

```yaml
version: 1
cases:
  - id: tents-under-1000-tr
    suite: factual
    language: tr
    turns:
      - user: 1000 TL altında çadır var mı?
        expect:
          answerable: true
          productType: outdoor/camping/tent
          filters: { maxPrice: 1000 }
```

The expectations say what must hold: the question is answerable, the
products are tents, and every product is under 1000 TL, or the answer says
it couldn't find one. The price, stock and policy checks need no expectation:
they judge every answer they apply to.

## How it works

![How yokla works: yokla run asks your assistant, the proxy sees its model calls, the checks judge each answer against your data, and yokla gate decides the build](https://raw.githubusercontent.com/thebozturk/yokla/main/docs/assets/how-it-works.svg)

- **The profile** maps your API: the request, where the answer and the
  products are, sessions, rate limits and tokens. Nothing about a particular
  assistant is built into yokla.
- **The checks** are deterministic first. A model is never needed to judge
  an answer.
- **Packs** add a domain or a language. The e-commerce, Turkish and English
  packs ship with yokla.

## The workflow

Nothing yokla writes judges your build until a person approves it. Every
command that proposes something marks it `proposed`, with where it came
from.

![The yokla workflow: a proposed profile you approve, cases you approve, yokla run and yokla gate, then a fix or a baseline](https://raw.githubusercontent.com/thebozturk/yokla/main/docs/assets/workflow.svg)

The [guide](https://github.com/thebozturk/yokla/blob/main/docs/guide/README.md)
walks through each step: [the analyzer](https://github.com/thebozturk/yokla/blob/main/docs/guide/analyzer.md),
[from a finding to its fix](https://github.com/thebozturk/yokla/blob/main/docs/guide/debugging.md),
[yokla in CI](https://github.com/thebozturk/yokla/blob/main/docs/guide/ci.md)
and [red teaming](https://github.com/thebozturk/yokla/blob/main/docs/guide/redteam.md).

## Try it on the demo-shop

From a checkout, with pnpm:

```sh
git clone https://github.com/thebozturk/yokla.git && cd yokla
pnpm install
pnpm --filter yokla-demo-shop start --port 3000 --defect fabricated-price
# in another terminal:
pnpm yokla run --profile examples/demo-shop/yokla.profile.yaml \
  --cases examples/demo-shop/cases --target-url http://127.0.0.1:3000/v1/chat
```

[The demo-shop's README](https://github.com/thebozturk/yokla/blob/main/examples/demo-shop/README.md)
lists every seeded defect and walks through a full run, with the model
proxy.

## Privacy

yokla sends no data anywhere. There is no telemetry. Its clients contact
only your target and the model providers you configure. The model proxy
listens on `127.0.0.1` only and forwards your app's own calls to the
upstreams your profile names. An egress test in CI holds yokla to that.

## Documentation

- [The guide](https://github.com/thebozturk/yokla/blob/main/docs/guide/README.md):
  a first run against your own assistant, and a page for each part.
  - Workflows: [the analyzer](https://github.com/thebozturk/yokla/blob/main/docs/guide/analyzer.md),
    [from a finding to its fix](https://github.com/thebozturk/yokla/blob/main/docs/guide/debugging.md),
    [yokla in CI](https://github.com/thebozturk/yokla/blob/main/docs/guide/ci.md),
    [red teaming](https://github.com/thebozturk/yokla/blob/main/docs/guide/redteam.md).
  - Reference: [the profile](https://github.com/thebozturk/yokla/blob/main/docs/guide/profile.md),
    [cases](https://github.com/thebozturk/yokla/blob/main/docs/guide/cases.md),
    [checks](https://github.com/thebozturk/yokla/blob/main/docs/guide/checks.md),
    [the model proxy](https://github.com/thebozturk/yokla/blob/main/docs/guide/model-proxy.md),
    [commands and configuration](https://github.com/thebozturk/yokla/blob/main/docs/guide/cli.md).
- [The design](https://github.com/thebozturk/yokla/blob/main/docs/design.md)
  and the [decision records](https://github.com/thebozturk/yokla/blob/main/docs/adr/README.md).
- [The changelog](https://github.com/thebozturk/yokla/blob/main/CHANGELOG.md).
- `yokla <command> --help`, and `yokla schema <profile|cases|config|results|baseline|comparison|analysis>`
  for the JSON Schemas.

## Roadmap

- **v0.6:** import and export for other evaluation tools, a GitHub Action and
  a library API.

## Packages

| Package | What it holds |
|---|---|
| [`yokla`](https://www.npmjs.com/package/yokla) | the command line |
| [`@yokla/core`](https://www.npmjs.com/package/@yokla/core) | schemas, the check API, aggregation and the gate |
| [`@yokla/runtime`](https://www.npmjs.com/package/@yokla/runtime) | the runner and the target adapters |
| [`@yokla/proxy`](https://www.npmjs.com/package/@yokla/proxy) | the model proxy |
| [`@yokla/report`](https://www.npmjs.com/package/@yokla/report) | terminal, JUnit XML and HTML reports |
| [`@yokla/analyzer`](https://www.npmjs.com/package/@yokla/analyzer) | the analyzer behind `yokla analyze` |
| [`@yokla/pack-ecommerce`](https://www.npmjs.com/package/@yokla/pack-ecommerce) | the e-commerce checks |
| [`@yokla/pack-lang-tr`](https://www.npmjs.com/package/@yokla/pack-lang-tr), [`@yokla/pack-lang-en`](https://www.npmjs.com/package/@yokla/pack-lang-en) | Turkish and English |

## License

[Apache-2.0](https://github.com/thebozturk/yokla/blob/main/LICENSE)
