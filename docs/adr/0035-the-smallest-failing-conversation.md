# 0035. The smallest failing conversation: yokla shrink

Status: Proposed · Date: 2026-11-15

## Context

A failing case is often longer than the failure it shows. A five-turn
conversation fails `price-grounded` on its fourth turn. Which earlier turns
does the failure need, and which words of each message? A person finds out
by editing the case and running it again, many times. On a target whose
answers vary, they can't even tell whether a run that passed shows a
smaller case that no longer fails, or a failure that came and went by
chance.

Design §20's debugging track plans this as D2. D1 (ADR-0033) already says
where a failure's value came from. D2 cuts the conversation down to what the
failure needs, so the person, or a coding agent later (D5), starts from the
smallest case that still shows it.

The runner already runs a case as many times as asked, applies the cache
bypass before every sample, and reports each turn's checks and findings
(design §11). The results give Wilson intervals over samples (design §13).

## Decision

### The command

```sh
yokla shrink --results runs/<run id>.json --case tents-under-500-tr \
  [--check price-grounded] [--samples 3] [--reproduce 5] [--max-runs 64] [--max-cost <usd>] \
  [--out cases/tents-under-500-tr.min.yaml]
```

- **What it shrinks.** One case of a results file whose status is `fail`,
  with the profile, cases and configuration a run takes. The case file must
  still hold the case with the definition hash the results recorded
  (ADR-0011); otherwise it refuses, because the failure belongs to another
  definition.
- **The failure it keeps.** The failing finding chosen by `--check`, or by
  default the first failing finding of a deciding dimension, in turn order
  and then check order. It is the *target*: its turn, its check, its
  dimension, and its origin's stage when it has one (ADR-0033).
- **What it refuses.** A simulated customer's case (ADR-0028): its turns are
  written by a model, so there is nothing fixed to cut. A case that isn't
  `fail`, and a check that didn't fail in it.

### When a candidate still fails

A candidate is a smaller version of the case. It *still fails* when, in
every one of its samples:

- the turn that corresponds to the target turn has a failing finding of the
  target check, in the target dimension, with the same origin stage when the
  target had one;
- no check fails on that turn that didn't fail on it in the original.

The second rule keeps the shrink from sliding into another failure: a
message cut to one word can fail `over-refusal` instead. Turns before the
target turn may pass or fail as they like; they are only context.

### Reproducing first

- **The original runs first,** `--reproduce` times, 5 by default.
  - Every sample still fails: the failure is reproducible, and shrinking
    starts.
  - Some samples fail and some don't: the failure is **flaky**. yokla
    reports the failure rate with its Wilson interval, writes no case, and
    exits with `1`. Shrinking a flaky failure would cut whatever happened to
    pass by chance.
  - No sample fails: the failure didn't reproduce. yokla says so and exits
    with `1`.
- **Each candidate runs `--samples` times,** 3 by default, and must fail in
  all of them. One run that passes rejects the candidate. A shrunk case is
  therefore one whose failure reproduced in every sample yokla ran.

### How it shrinks

The search is deterministic, so the same results and the same answers give
the same shrunk case.

1. **Turns after the target turn are dropped,** without a run: they can't
   change it.
2. **Earlier turns** are removed by delta debugging: halves, then quarters,
   down to single turns, keeping each removal that still fails. The target
   turn always stays.
3. **Each kept message,** the target turn's last, is cut the same way over
   its words, split on whitespace and joined with one space. A message
   keeps at least one word.
4. **A turn's other fields go with it:** its expectations, faults, request
   additions and deadline. Expectations are never edited: a candidate that
   makes a check inapplicable doesn't fail it, so it is rejected.

The result is minimal in this sense: removing any one remaining turn, or any
one remaining word, makes it stop failing.

### Budget

- **`--max-runs`,** 64 by default, caps the candidates run after the
  reproduction. At the cap, the smallest failing candidate so far is the
  result, and yokla says the search stopped early.
- **`--max-cost`** caps model cost as `yokla run --max-cost` does
  (ADR-0014), over the whole shrink.
- **The estimate.** Before it sends anything, yokla prints the most runs it
  can make, `reproduce + max-runs × samples` runs of the case. With
  `--calibration <results>` it also prints their cost from that run, and the
  upper bound `plan` would give (ADR-0014). Without calibration it gives no
  cost figure.

### What it writes

- **A case file,** at `--out`, or by default next to the original case's
  file as `<case id>.min.yaml`. It never overwrites a file.
  - Its id is `<case id>-min`, and its status is `proposed`, so it runs and
    is reported but doesn't gate until a person approves it (ADR-0004).
  - Its provenance has a new machine source, `shrink`, with the evidence
    `shrunk from <case id> in run <run id>, failing <check>`.
  - It keeps the original's suite, language, checks and tags.
- **A summary** on the terminal: turns and characters before and after, the
  runs made, the cost, and the target failure with its origin.

### Layers

- **`core`** holds the search: candidates from a case, delta debugging, and
  the rule that decides whether a candidate's results still fail. It runs
  nothing.
- **`runtime`** runs each candidate as one case of an ordinary run, with the
  profile's cache bypass, rate limits and proxy recording.
- **`cli`** adds the command.

### The demo-shop

For every in-process defect, the acceptance shrinks one failing case that
has more than one turn or more than one word to cut. The shrunk case must
fail only its own check, as the original does, and be no larger, and at
least one must be smaller. A seeded flaky failure, a demo-shop defect that
fails every other answer, is reported as flaky and not shrunk.

## Consequences

- **A failure arrives as its smallest case.** A person reads two turns, not
  ten, and a fix can be checked against a case that shows only that failure.
- **Shrinking calls the target many times.** On a real target that costs
  money, the estimate, `--max-runs` and `--max-cost` bound it. The default
  of 64 candidates with 3 samples each can be up to 197 runs of the case.
- **A shrunk case is still a proposal.** It is often less natural than the
  original, and a person decides whether it belongs in the suite.
- **Data-grounded cases shrink against today's data.** A candidate is judged
  with the current catalog, as any run is.
- **Provenance gains a source.** `shrink` joins the machine sources; the
  profile and cases schemas change additively.
- **Simulated conversations aren't shrunk yet.** A later ADR can shrink a
  recorded conversation once D4 can replay one.

## Alternatives considered

- **Removing turns from the end, or one at a time, only.** Simpler, but
  linear in the number of turns on every pass, and blind to a failure that
  needs the first turn and the last. Rejected for delta debugging, which
  finds the same minimum in fewer runs on long cases.
- **Accepting a candidate that fails in most of its samples.** That shrinks
  flaky failures too, towards whatever fails by chance. Rejected: a
  candidate must fail in every sample, and a flaky original isn't shrunk.
- **Rewriting messages with a model,** paraphrasing them shorter. It costs
  money, can change the meaning, and makes the search nondeterministic.
  Rejected; cutting words is enough for a minimal case.
- **Shrinking from the results alone, without the target.** The results
  can't say how the target answers a message it never got. Rejected.
- **Writing the shrunk case into the original file.** It would change an
  approved case without review. Rejected: a new file, proposed.
