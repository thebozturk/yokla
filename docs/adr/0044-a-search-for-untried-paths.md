# 0044. A search for untried paths

Status: Proposed · Date: 2026-11-16

## Context

Written cases test what their writers thought of. A defect on a path no case
takes, such as a cart that holds two products, or a policy no case asks
about, stays hidden however many samples run.

The run already sees which path each turn took:

- the route the target answered on, where the profile maps one;
- through the model proxy, the tools the model asked for and their
  arguments (ADR-0025), and the faults that applied (ADR-0013).

Most of yokla's checks need no expectation from the case: `price-grounded`,
`stock-claim`, `no-duplicates`, `tool-call-valid`, the response contract and
`everyAnswer` (ADR-0030), the inspection checks (ADR-0015), and
`graceful-under-fault` under a fault. A turn nobody wrote is still judged.

Design §20's debugging track plans this as D8: "a run that steers new turns
towards what the proxy hasn't seen yet: routes, tool sets, argument shapes,
fault states; deterministic mutations first, a model-written turn only when
configured and budgeted". Its exit criterion: "on the demo-shop, the search
reaches every route and every tool, and finds a seeded defect that no
written case reaches".

## Decision

### The command

```sh
yokla explore --profile yokla.profile.yaml --cases cases \
  [--max-runs 64] [--max-cost <usd>] [--out explored.yaml] \
  [--config <file>] [--target-url <url>] [--proxy-url <url>]
```

- **The seeds are the written cases.** They run once, one sample each, and
  what they reach is the coverage to beat.
- **Then candidates run, one at a time,** each a small conversation of one
  sample, until `--max-runs` candidates have run (64 by default), the cost
  cap is reached, or no operator has a candidate left.
- **A candidate is kept** when it reaches something no run before it did, or
  when a check fails on it. Kept candidates join the pool the operators
  draw from, so the search goes on from where it got to.
- **Deterministic.** Operators are applied in a fixed order to the pool in
  the order it grew, so the same seeds, data and answers give the same
  search.
- **Before it sends anything,** it prints the most runs it can make. Its
  model cost is capped as a run's (ADR-0014), and a session that can spend
  needs `--max-cost`, as `yokla mcp` does (ADR-0041).

### What is new

Coverage is a set of what the runs reached:

- **a route,** where the profile maps `response.route`;
- **a tool** the model asked for, through the proxy;
- **an argument shape:** a tool with the sorted keys of its arguments, such
  as `search_products{priceMax,productType}`;
- **a fault state:** a route the target answered on under a fault kind.

Without a model proxy, only routes count, and the search says so. Without a
mapped route either, it refuses: it has nothing to steer by.

### The operators

**Generic, in core,** over the pool's cases:

- **follow-up:** a case's turns, then the first turn of another case;
- **repeat:** a case with its last turn asked again;
- **fault:** a case with one fault kind on its last turn, from a fixed list
  (a `503`, a timeout, empty content, malformed JSON); only with the proxy.

**Domain intents, from the packs.** A domain pack can offer turns built
from the target's own data and profile. The e-commerce pack, in each of the
profile's languages:

- asks for a product of the catalog by its name;
- asks for a product type of the catalog, and for it under a price;
- asks about each policy the profile declares;
- after an answer that showed products, asks to add the first to the cart,
  and asks for a cheaper one.

Its phrasings are templates of the pack, one set per language; they say
nothing of a particular target (P9). Core knows nothing of e-commerce (P7).

### Judging

- **A candidate is a case like any other,** run with the profile's cache
  bypass, limits and proxy recording, and judged by every check.
- **It carries no expectation,** but for a fault's: the checks that need
  none judge it. An intent knows no right answer, so it states none.

### What it writes

- **A coverage map** on the terminal, and in the results file of the
  exploration (results.v1, additive `run.coverage`): what the seeds reached,
  what the search added, and the tools the model was offered but never
  asked for.
- **A case file** at `--out`, by default `explored.yaml` next to the
  profile, never overwriting one:
  - each kept candidate as a case, `<operator>-<n>`, with status `proposed`
    (ADR-0004) and a new provenance source, `explore`, whose evidence names
    what it reached first or the check it failed;
  - the cases a check failed on first.
- **A model-written turn is left to a later ADR,** under the rules of
  yokla's own model calls (ADR-0028).

### The demo-shop

- **A new defect, `cart-total-off`.** When the cart holds two products or
  more, the shop answers with each product's price and a total. The correct
  total is the sum, which `price-grounded` grounds (ADR-0022); with the
  defect it is 10 % lower. No written case puts two products in a cart.
- **The end-to-end test** explores from the acceptance cases with the
  model over HTTP behind the proxy, at no model cost:
  - the search reaches every route (`product-search`, `policy`,
    `follow-up-cheapest`, `cart`, `refusal`, `fallback`) and every tool
    (`search_products`, `get_policy`, `cheapest_shown`, `add_to_cart`);
  - on the shop with `cart-total-off`, the acceptance cases all pass, and a
    proposed case fails `price-grounded` on the turn after its second cart
    addition;
  - without the defect, no explored case fails;
  - two explorations of the same shop write the same cases.

## Consequences

- **A team learns which paths its cases never take,** and gets proposed
  cases for them, to approve or drop.
- **A defect off the written paths can be found** by the checks that need no
  expectation. A defect that only an expectation can show still needs a
  case that states it.
- **Explored cases are proposals.** They hold what the target answered
  without saying it was right, so they gate only once a person approves
  them.
- **Domain packs gain a role:** intents built from the target's data. The
  e-commerce pack is the first; other domains add theirs.
- **The search costs runs.** On a paid target, `--max-runs` and `--max-cost`
  bound it, and its estimate is printed first.

## Alternatives considered

- **Random mutations of messages,** such as typos or shuffled words. They
  rarely reach a new path, and they are v0.4's robustness transforms (§9),
  which keep a case's verdict rather than search for new paths. Rejected
  for operators that reach paths.
- **Only recombining the written cases' turns.** It can't ask for what no
  case asked, such as a cart; the exit criterion couldn't hold. Rejected for
  intents from the packs as well.
- **Coverage by routes and tools alone.** It would call a tool new once,
  whatever its arguments or faults. Rejected for argument shapes and fault
  states, as design §20 names them.
- **A model writing the next turn now.** It reaches paths templates can't,
  but costs money and varies. Deferred to its own ADR.
- **Writing every candidate as a case.** Most add nothing. Rejected: only
  those that reach something new or fail a check are kept.
- **Explored cases that gate at once.** Nobody has read them. Rejected:
  they are proposed (ADR-0004).
