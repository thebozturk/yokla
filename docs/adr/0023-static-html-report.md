# 0023. A static HTML report

Status: Accepted · Date: 2026-11-13

## Context

A run's results file holds every turn: the user's message, the answer, the
evidence, each check with its findings, the timings and the model calls. The
terminal summary and JUnit XML give one line per case that didn't pass. To see
why a case failed, a person reads the JSON. Every false alarm behind ADR-0020
to ADR-0022 was found that way, with a script written for the purpose.

Design §16 plans a single-file offline HTML report for v0.3. Three things
shape it.

- **The answers are untrusted text.** An answer may hold markup, a script or
  an injection payload. yokla's own attack cases try to provoke exactly that.
- **No data leaves the machine (ADR-0003).** Opening the report must contact
  nobody, not even a font server.
- **The answers are the target's data (§15).** The terminal summary and JUnit
  leave them out. A report that shows them has to say so.

## Decision

### What it is

- **One HTML file, rendered from the results file alone (ADR-0007).**
  - `@yokla/report` renders it.
  - `yokla run --html <file>` and `yokla report --results <file> --html
    <file>` write it, as `--junit` does.
- **Offline and inert.**
  - Its styles are inline. It has no script, and it loads no font, image or
    stylesheet.
  - A Content-Security-Policy meta tag (`default-src 'none'; style-src
    'unsafe-inline'`) makes the browser hold it to that.
  - A case opens and closes with `<details>`, which needs no script.
- **Every value is escaped.**
  - The target's text, the user's messages, the finding messages and the
    evidence are text, never markup.
  - A link in an answer is shown, not made clickable.
- **The same results give the same bytes.**
  - The report holds no render time and no locale formatting.
  - Times are shown as the results file stores them, in UTC.
  - So reports can be compared, and tested as snapshots.

### What it shows

- **The run.** Its id, target, start and duration, the yokla version, the
  correlation, whether it is partial, its issues, and the totals of the model
  proxy and of the target's logs.
- **The statuses.**
  - The count of each status.
  - A table of the cases, with the same one-line reason as the terminal
    summary. Proposed and unstable cases are marked.
- **The checks.** For each check: how many turns it applied to, wasn't
  applicable to, passed, failed, errored on and couldn't measure. A check that
  never applied is visible (design §10).
- **Each case.** Its dimensions with their verdicts, failure counts and
  intervals. Then, for every sample and turn:
  - the user's message;
  - the answer: its status, latency, time to first text, route and text;
  - the turn's errors and mapping issues;
  - the checks that applied, with each finding's verdict, dimension,
    severity, message and evidence;
  - the checks that didn't apply, by name, and what couldn't be measured;
  - the evidence the profile mapped, closed by default;
  - the model calls: model, status, duration, tokens, cost and fault;
  - the fields observed in the target's logs.
- **The order.** Cases that didn't pass come first, open. Cases that passed
  follow, closed.
- **The presentation.**
  - A status is always written out, never shown by colour alone.
  - Light and dark themes follow the system.
  - The page prints.

### What it leaves out

- **Prompts.** A model call's messages are shown by role and size only,
  whatever `prompts.store` keeps (ADR-0015).
  - A system prompt can be long and confidential.
  - The inspection checks' findings already say what they found.
- **The gate's verdict.** The gate needs the configuration and the baseline,
  and the report reads the results alone. The gate keeps its own output and
  exit code.

### What the guide says

- The HTML report holds the target's answers and evidence. It is target data,
  like the results file.
- Keep it out of version control when the answers may hold personal data.
- The terminal summary and JUnit XML still hold none of the answers.

## Consequences

- **A failed case is read without a script.** The finding, the answer and the
  evidence that decided it are on one page.
- **Sharing the report shares the answers.** It is as private as the results
  file.
- **Hostile answers stay text.**
  - Escaping is the first defence, and the policy is the second. With no
    script allowed, a missed escape can't run code.
  - Tests render answers that hold markup and scripts. They check that the
    report has no script, no external resource and no link out.
- **No search and no filters.** Without a script the report can't filter
  cases. The browser's own search works, and the cases that didn't pass come
  first.
- **The file grows with the results.** It holds every turn's answer and
  evidence, as the results file does.
- **results.v1 doesn't change.**

## Alternatives considered

- **A page with a script, for search and filters.** It would put the
  target's untrusted text next to running code. Without a script, an escaping
  bug can't become code execution. Rejected for now.
- **Styles, fonts or a chart library from a CDN.** Opening the report would
  contact a third party, against ADR-0003, and it wouldn't work offline.
  Rejected.
- **Leaving the answers out, as JUnit does.** The report exists to show what
  the target said next to the verdict. Rejected. The report is documented as
  target data instead.
- **Rendering prompts when the results keep them.** Deferred until an
  inspection finding needs more than its message.
- **The gate's verdict in the report.** The report would then need the
  configuration and the baseline, and could no longer read the results alone.
  Deferred: `yokla gate` could write its own HTML later.
