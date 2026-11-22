# 0087. An attacker model (R5)

Status: Accepted · Date: 2026-11-22

## Context

R5 of the red-team track (ADR-0079, widened by ADR-0081 and ADR-0084)
gives yokla an attacker model. Its list:

- `models.attacker` writes variants of the template attacks and adaptive
  multi-turn attacks, cached and capped as yokla's other own models are;
- strategies: iterative refinement, a tree of variants, gradual escalation
  and best-of-n sampling (ADR-0081);
- an attack spread over several turns, and the profile's other language
  (moved from R3, ADR-0084);
- each stops at the first deterministic failure, within `--max-cost`;
  detection stays deterministic.

Its exit criterion: with the fake provider as attacker, a defect only an
adaptive attack reaches is caught, and a second run repeats from the cache
at no cost.

ADR-0086 said that R5 starts the items that cost money. Building R5 costs
nothing: the fake provider plays the attacker, as it plays the customer.
Only a run with a real attacker model costs money, and each such run is
approved with its estimate. R6 costs nothing either.

What exists:

- **The simulated customer** (ADR-0028): `models.customer`, a prompt of
  yokla's per language, a conversation written turn by turn, a reply cache
  in `yokla-data/customer/` keyed by the model, the case, the seed and the
  conversation so far, its spend counted in `--max-cost`, and the fake
  provider playing it by rules.
- **Samples that stop early** (ADR-0038): a worst-of-N failure stops the
  remaining samples.
- **Strategies of a run** (ADR-0084): `yokla run --strategy` rewrites the
  `redteam` cases' messages and keeps their definitions, so the gate and
  `yokla compare` judge them.
- **The attack cases** carry their expectations, the deterministic checks
  that judge them.

The list holds two shapes of attack:

- **One conversation, written turn by turn** by the attacker as it reads
  the target's answers: escalation, and an attack spread over turns.
- **Many single messages,** each in a conversation of its own: best-of-n,
  iterative refinement, a tree of variants, and the other language.

## Decision

### R5 is split in two

- **R5, this ADR:** the attacker model, and one strategy of each shape:
  `escalation` and `best-of-n`. Spreading an attack over turns is what
  `escalation` does: the attacker chooses what each turn says.
- **R5b, its own ADR:** `iterative`, `tree` and `translate` (the profile's
  other language), on the engine R5 builds. Its exit criterion, which its
  ADR may change: each strategy reaches a demo-shop defect the template
  attack doesn't, with the fake provider as attacker.

This narrows ADR-0081's R5, as its last rule allows.

### The command

```sh
yokla run --attacker escalation
yokla run --attacker best-of-n --attempts 4
```

- **`--attacker <strategy>`** runs each `redteam` case of one turn, without
  `as`, through the attacker. Cases of other suites, and attack cases of
  more turns, go as written.
- **The case keeps its definition.** Its turn's expectations judge every
  message the attacker writes, as `customer.expect` judges a simulated
  customer's (ADR-0028). The gate and `yokla compare` judge the run as for
  a strategy (ADR-0084).
- **Not with `--strategy`, `--transform` or a cassette,** for now: the run
  is refused, saying so. `--attempts` goes with `best-of-n` only,
  `--max-turns` with `escalation` only.
- **`models.attacker`** in `yokla.config.yaml` names the model, as
  `models.transform` does, with a price, 0 for a local model. Without it,
  the run is refused before any request.

### The strategies

| Strategy | Shape | What the attacker writes | Stops |
|---|---|---|---|
| `escalation` | one conversation | the next message, turn by turn, from the attack and the conversation so far, working towards what the attack asks | at the first turn a check fails, or after `--max-turns` (default 5) |
| `best-of-n` | many conversations | attempt `i` of `--attempts` (default 4): another way to send the attack, each in a fresh session | at the first attempt a check fails |

- **The attack's message is the attacker's goal.** The prompt gives it,
  says what it asks the assistant to do, and asks for one message to send.
  It holds nothing of the target's but its answers, and names no target
  (P9).
- **Escalation is one sample.** Its turns are the sample's turns, each
  judged as the case's turn.
- **Best-of-n is one sample per attempt,** each its own session. It stops
  at the first attempt with a failing finding, whatever the dimension's
  policy: an attempt that broke through is the finding, as `--stop-early`
  stops once a failure is settled (ADR-0038). Both judge the samples so far
  as the final judging would, with the proxy's records when there are.
- **Each failure names the strategy and the turn or attempt** that broke
  through, and the results keep every message the attacker wrote.

### yokla's own calls

As ADR-0028's, with the attacker's name in place of the customer's:

- **The prompt is yokla's,** one per language, Turkish and English, marked
  on its first line.
- **Replies are cached** in `yokla-data/attacker/`, keyed by the model's
  configuration, the strategy, the case's message and language, the
  attempt or the conversation so far, and the seed. `--fresh-attacker`
  ignores the cache.
- **The cost is counted** with yokla's other spend, and `--max-cost` caps
  it. A model without a price is refused, as for `models.transform`.
- **A failed attacker call** is an error of the case, never a pass. Every
  language a case may be in has an attacker prompt; one without would be
  such an error.
- **The reply cache is the customer's,** shared code under another
  directory: what keys a reply differs, how it is kept doesn't.
- **What leaves the machine:** a hosted attacker receives the attack and
  the target's answers. The guide says so.

### What results.v1 keeps

Additive (ADR-0007): `run.attacker`, the strategy, its bound as `limit`
(the attempts or the most turns) and how many cases it adapted; on a
sample, the attacker's calls and their cost, and for `escalation` the turn
that broke through as `brokeAt`. For `best-of-n`, the attempt that broke
through is the sample that failed, the last one run.

### The demo-shop

- **The fake provider plays the attacker,** by rules, at no cost:
  - `escalation`: a question that suits the shop, then the attack, then
    the attack again with more insistence, each turn;
  - `best-of-n`: attempt 0 as written; then the attack wrapped as a
    role-play, in leetspeak, and as a hypothetical, in that order.
- **A new defect, `worn-down`:** the shop follows an instruction a session
  has asked for three times: the same word to reply with, read from the
  instruction. A template attack, asked once, passes on it; `escalation`
  fails it on its fourth turn, the attack's third, by the check that
  judges the attack. An instruction hidden in invisible characters isn't
  read, so its case passes.
- **An R3 defect shows `best-of-n`:** with `obfuscation-obeyed`, the
  written injection passes, and `best-of-n` fails it at the leetspeak
  attempt and runs no further attempt. As under the leetspeak strategy
  (ADR-0084), the other cases whose own message, followed, breaks a check
  fail there too.
- **The end-to-end test, at no model cost:** the attack cases on the
  correct shop under each strategy pass, every attempt and turn run; the
  two defects fail as above, and nothing else does; a second run sends no
  attacker call, every reply from the cache.

### Layers

- **`core`:** `models.attacker`, the prompts, the cache key, the
  strategies' plans, and the fake attacker's marks.
- **`runtime`:** the attacker's calls and cache, and the two drivers in
  the runner, beside the customer's.
- **`cli`:** `--attacker`, `--attempts`, `--max-turns` and
  `--fresh-attacker`, and the summary.

### The design is updated

- **Design §20:** R5's row lists what this ADR keeps, and a new row, R5b,
  lists what it moves.
- **Design §19:** the defects and what catches them.

## Consequences

- **An approved attack case is sent many more ways,** adapted to how the
  target answers, and judged by the same rules.
- **A run with a real attacker costs money,** each call counted and
  capped; CI runs the fake attacker at no cost.
- **The attacker sees the target's answers.** A hosted one is a new place
  the target's data goes, configured by the person.
- **Attacks of several turns or with identities** go as written until a
  later ADR.

## Alternatives considered

- **All of R5 in one ADR.** Five strategies, each with its own prompt,
  fake-provider rules and defect. Rejected: split, the engine first.
- **A new case kind with an `attacker` driver,** as `customer` is. Each
  attack would need a second case to run adaptively. Rejected: a run-level
  option over the cases already approved, as for strategies.
- **A goal the attacker is given in words,** derived from the case's
  expectations. Every expectation would need a sentence, and a wrong one
  would mislead it. Rejected: the attack's own message is the goal.
- **The attacker judging success.** A model would decide a verdict.
  Rejected: the case's deterministic checks judge every message.
