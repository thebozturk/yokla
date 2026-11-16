# 0042. Comparing models through the proxy

Status: Proposed · Date: 2026-11-16

## Context

A team that runs an assistant on one model asks, sooner or later, whether
another would do: a cheaper one, a newer one, one from another hosting of
the same API. Today the answer takes a change to the app's configuration,
a run, the change undone, another run, and a comparison by hand of two
results files.

The model proxy already sits on every call the app makes (ADR-0012). It
reads the model each call asks for, from the body for OpenAI-compatible and
Anthropic calls and from the path for Gemini (ADR-0032), prices each call by
the model that answered, and can change a call within a recording for a
fault plan (ADR-0013). The gate already judges one run against thresholds
and a baseline (ADR-0010, ADR-0011, ADR-0014).

Design §20's debugging track plans this as D6: "the proxy can send a call to
another model than the app asked for, as the profile or the command line
says; the same cases run once per model, and a report compares verdicts,
cost and latency". Its exit criterion: "on the demo-shop, two fake models
give the comparison expected of them; the cheapest model that still passes
the gate is named".

## Decision

### Swapping a model

- **`yokla run --swap-model <upstream>:<asked>=<model>`,** repeatable. Each
  call to that upstream that asks for `<asked>` goes to `<model>` instead.
  - **`<upstream>:<asked>=<other>/<model>`** sends it to another upstream of
    the same kind, such as a second OpenAI-compatible gateway, with the app's
    own credentials as for any call (ADR-0012).
  - **Only the asked model is matched,** so an app that interprets with a
    small model and writes with a large one can swap each apart.
- **The same protocol only.** The proxy changes the model's name and nothing
  else: the body's `model` for OpenAI-compatible and Anthropic calls, the
  `models/{model}` segment of the path for Gemini. The answer is read as it
  is today.
  - A body that a swap changes is sent uncompressed, with its new length, as
    a body a fault changes (ADR-0013).
  - A call whose body isn't JSON, or names no model, isn't swapped.
- **Within a recording only.** The runner sends its swaps when it opens the
  recording, as it sends a cassette (ADR-0040). Outside a recording the proxy
  never changes a call (ADR-0012).
- **What a swapped call records.** Its record and its turn's results keep the
  model the app asked for as `asked`, next to the model that answered. Its
  cost is the answering model's price: a swapped model without a price costs
  null, never 0, so the cap stops there as for any call (ADR-0014).
- **What the run records.** `run.swaps` lists each swap, and how many calls it
  changed. A swap that changed no call is a run issue: the app may ask for
  another name, and the run measured the model it meant to replace.
- **Faults apply as they do,** `answer` included: a swapped call is a call.
- **Not with a cassette.** `--swap-model` with `--record` or `--replay` is
  refused: a cassette would hold another model's answers under the app's
  requests, and replay them without the swap. A later ADR can record swaps in
  the cassette.
- **Without a model proxy with upstreams,** the run refuses before any
  request.

### Comparing runs

```sh
yokla compare --results runs/as-is.json --results runs/mini.json --results runs/nano.json \
  [--config yokla.config.yaml] [--baseline yokla.baseline.json] [--json compare.json]
```

- **It reads results files and contacts nothing,** as the gate does
  (ADR-0010). Running and judging stay apart: each model is a run of its
  own, which a person or CI can repeat, gate or keep.
- **Each run is named by its swaps,** such as `fake: demo-writer-1 →
  demo-writer-mini`, or "as the app asks" with none.
- **Per case,** the status in each run, with the cases whose statuses differ
  first. A case whose definition differs between runs is reported, not
  compared (ADR-0011). A case missing from a run is shown as missing.
- **Per run:**
  - the gate's verdict, with the configuration's thresholds and the
    baseline, as `yokla gate` would give it, and its breaches;
  - the statuses;
  - the total model cost and the mean cost per answered turn, or that a call
    had no cost;
  - the latency p50 and p95 of every answered turn, as the gate computes
    them (ADR-0014).
- **The cheapest run that passes the gate is named,** by total cost. A run
  whose cost isn't known can't be named; when one of the passing runs has an
  unknown cost, the comparison says it can't name the cheapest. Equal costs
  name every run that ties.
- **Runs from different profiles** are compared, and the comparison says so,
  as the gate notes a baseline from another profile (ADR-0010).
- **Exit codes:** `0` compared, whatever the verdicts; `2` when a file can't
  be read or fewer than two runs are given. `yokla compare` judges nothing
  itself: the gate of each run decides.
- **`--json`** writes the comparison for CI. Its schema is generated like
  the others (ADR-0008).

### results.v1

Additive (ADR-0007): `run.swaps`, and an optional `asked` on each model
call of a turn.

### The demo-shop

- **The fake provider answers three writer models,** by the name a call
  asks for:
  - `demo-writer-1`, as today;
  - `demo-writer-mini`, with the same answers;
  - `demo-writer-nano`, which writes the first product's price wrong, as
    `fabricated-price` does.
- **Their prices,** in the demo-shop's configuration for the end-to-end
  test, fall from the first to the last.
- **The end-to-end test** runs the acceptance cases three times through the
  proxy: as the app asks, swapped to `demo-writer-mini`, and swapped to
  `demo-writer-nano`.
  - The provider's usage log shows each run's calls with the model that
    answered, and each call records the model the app asked for.
  - `yokla compare` shows `demo-writer-nano`'s product cases failing
    `price-grounded`, with the origin `model` (ADR-0033), and names
    `demo-writer-mini` as the cheapest run that passes the gate.
  - A swap of a model the app never asks for is a run issue.

## Consequences

- **A model is compared on the app's own cases,** with the app unchanged:
  its prompts, tools and post-processing stay as they are, and only the
  model behind them changes.
- **Three models, not two,** in the demo-shop's acceptance, so "the cheapest
  that passes" isn't simply the cheapest.
- **Only models that speak the app's protocol** can be compared. A model
  behind another protocol needs the app's own switch, or a later ADR.
- **A swapped model's quirks are the model's.** A model that ignores a tool
  or a parameter the app relies on fails the cases that need it, which is
  what the comparison is for.
- **The cost of a comparison is a run per model.** Each run is planned and
  capped as any run is (ADR-0014): `yokla plan` estimates it from a
  calibration, with the swapped model's prices.

## Alternatives considered

- **Translating between protocols,** such as an OpenAI-compatible call sent
  to an Anthropic model. Tool calls, streams and usage would each need a
  mapping both ways. Rejected for now: the same protocol covers models of
  one provider and of gateways that speak its API.
- **Swapping every call of an upstream.** Simpler, but an app that uses two
  models for two jobs would have both replaced by one. Rejected for a swap
  by the asked model.
- **Swaps in the profile.** The profile describes the target as it is (P9);
  which model to try is a choice for a run, like `--samples`. Rejected for
  the command line; the configuration can hold swaps later if teams repeat
  them.
- **One command that runs every model and compares.** Shorter to type, but
  it joins running and judging, which ADR-0010 keeps apart, and its runs
  couldn't be gated or kept one by one. Rejected for `yokla run` per model
  and `yokla compare`.
- **Naming the cheapest model by its price table alone.** Prices per token
  say nothing of how many tokens a model uses for the same task. Rejected:
  the comparison uses the cost each run measured.
- **A score that weighs verdicts, cost and latency together.** It would
  hide a failing case behind a cheaper run. Rejected: a run passes the gate
  or doesn't, and only then is cost compared.
