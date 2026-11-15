# 0040. Recorded model calls, replayed

Status: Proposed · Date: 2026-11-15

## Context

Every run of a target with a real model costs money and varies with the
model. Two questions can't be answered cheaply today:

- **Did a change to the app break it?** A team changes a prompt template,
  a retrieval rule or a post-processing step, and wants to run the suite
  again. Each run calls the model again, pays again, and gets answers that
  differ from the last run's for reasons that have nothing to do with the
  change.
- **What does the app do when the model says something else?** Fault plans
  (ADR-0013) break the provider: errors, stalls, empty or malformed
  answers. They can't make the model say a particular wrong thing, such as
  a price it wasn't given, to see whether the app passes it on.

The model proxy already sees every call and its answer (ADR-0012,
ADR-0033). It can change an answer for a fault plan, and it keys a turn's
fault jitter by case, sample and turn, so the same turn gets the same draw
in every run (ADR-0017).

Design §20's debugging track plans this as D4.

## Decision

### Recording

- **`yokla run --record <cassette>`** writes a cassette: every model call
  the proxy tied to a turn, with what is needed to answer it again.
- **Per call it keeps:**
  - the turn's key, as ADR-0017 seeds jitter: case, sample and turn;
  - the call's position among the turn's calls, its upstream and its path;
  - the SHA-256 of the request body, and never the request itself;
  - the answer as the app got it: status, content type and body, a stream
    as its bytes.
- **The proxy hands the bodies to the runner** when the runner asks for
  them at open, and only for that recording. The proxy writes no cassette
  itself.

### Replaying

- **`yokla run --replay <cassette>`** sends the cassette to the proxy when
  the run opens its recording. The proxy answers each call from it and
  forwards nothing upstream.
- **How a call finds its answer.** Within the call's turn, the first unused
  recorded call with the same upstream, path and request hash. Without
  one, the call **diverged**: the app asked something it didn't ask when
  the cassette was recorded.
  - A diverged call gets a `502` answer that says so, and the turn records
    it. The case is `error`: its answers would come from a model that was
    never asked this.
  - **`--replay-loose`** answers a diverged call with the recorded call at
    the same position, upstream and path instead, and marks it diverged in
    the results. It suits an app whose prompts hold a timestamp or a fresh
    id; the run issues say how many calls diverged.
  - A turn with no recorded calls, or more calls than were recorded, has
    nothing to answer from: those calls diverge too.
- **What a replayed call records.** Its usage and cost are the recorded
  call's, so cost checks and budgets judge it as before. It is marked
  `replayed`, and it costs nothing: the cost cap (ADR-0014) counts only
  calls that reached a provider.
- **Latency isn't the model's.** A replayed answer arrives at once. The
  results record `replay` on the run, and the gate judges a replayed run's
  latency thresholds as unmeasured. A latency fault still delays a replayed
  answer.
- **Faults apply on top.** A turn's fault plans apply to a replayed answer
  as to a live one, so the resilience cases run on a cassette.

### Changing one answer

- **A new fault kind, `answer`,** replaces the text of the model's answer
  with the plan's `text`, in the provider's own shape: chat completions
  and the Responses API, Anthropic and Gemini, JSON or a stream.

  ```yaml
  faults:
    - fault: { kind: answer, text: "Kamp Çadırı: 1.169,10 TL (stokta)" }
      calls: [2]
  ```

  - Tool calls in the answer stay as they were.
  - It works on a live call and on a replayed one: on a cassette, the turn
    keeps every other recorded answer, which is the question "what if the
    model had said this".
  - Its origin, when a check fails on the replaced value, is `model`
    (ADR-0033): the app got it from the model.

### What the cassette holds

- **The model's answers,** in full: they may hold personal data from the
  target's prompts or its data. A cassette is kept like a results file:
  `runs/` stays out of version control (design §15). It holds no request
  text and no credential.
- **A version and the profile's hash,** so a replay can say when the
  cassette came from another profile. A cassette from another schema
  version is refused.

### Without a model proxy

`--record` and `--replay` need the profile's model proxy, with upstreams:
without one, the run refuses before any request.

### The demo-shop

- **A recorded run replays with the same results,** case for case and
  finding for finding, and the fake provider's usage log gains no entry.
- **The resilience cases run on the cassette** and catch each resilience
  defect, as they do live.
- **A changed answer:** a case whose writer answer is replaced with a price
  no product has fails `price-grounded` with the origin `model`, on the
  cassette.
- **A diverged call:** a cassette recorded without a defect, replayed
  against a demo-shop whose prompt changed (`prompt-bloat`), makes the
  affected cases `error`; with `--replay-loose` they run, and the issues
  count the diverged calls.

## Consequences

- **A suite repeats at no model cost,** with the answers it got, so a
  change to the app shows as a change in results, not as model noise.
- **The model can be made to say one thing,** in the turn and call a case
  names, on a live run or a cassette.
- **A cassette goes stale** when the app's prompts change. Strict replay
  says so instead of answering with something the model wasn't asked;
  recording again refreshes it.
- **Replayed latency means nothing,** so the gate doesn't judge it.
- **yokla's own model calls,** such as the simulated customer's, aren't
  replayed by the proxy; their reply cache (ADR-0028) already makes them
  repeat.

## Alternatives considered

- **Matching calls by request alone, across the run.** Two turns that send
  the same prompt would share answers, and order would decide which. The
  turn key keeps each answer with its turn.
- **Storing the request text,** to show how a diverged call differs. It
  would put the target's prompts in a file outside `prompts.store`
  (ADR-0015). Rejected: a hash says whether it differs, and `--record` with
  `prompts.store: full` in the results shows how.
- **The proxy reading and writing cassette files.** The proxy would gain a
  file system role, and a path the runner and proxy must agree on.
  Rejected: the runner owns files, as it owns results.
- **Answering diverged calls by default.** Answers from a cassette that
  doesn't fit what the app asked could pass a case that live would fail.
  Rejected as the default; available as `--replay-loose`.
- **A separate mechanism for changed answers.** Fault plans already select a
  turn, a call and an upstream, and the proxy already changes answers for
  them. Rejected: a fault kind is enough.
