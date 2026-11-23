# 0092. The ecosystem track: v0.6 in six items

Status: Proposed · Date: 2026-11-23 · Amends 0007

## Context

Design §20 gives v0.6 its scope in one row: import and export for other
evaluation tools; CI recipes and a GitHub Action; a library API; two runs
compared side by side; a documentation site. The row has no exit criteria
yet.

Some of it exists already:

- **CI.** `yokla run` and `yokla gate` exit with codes a pipeline
  understands, and write JUnit XML and a static HTML report (ADR-0023). The
  guide's CI page has a GitHub Actions workflow to copy.
- **Runs side by side.** `yokla compare` sets runs of the same cases side by
  side: each case's status per run, each run's gate verdict, cost and
  latency, and the cheapest run that passes (ADR-0042, ADR-0043). It doesn't
  show what changed inside a case: its findings or its answers.
- **A programmatic surface.** The nine packages are published (ADR-0034),
  and `@yokla/runtime` exports `runSuite`. But no surface is documented or
  promised: loading, running and writing come together only in the CLI's
  commands. The one public API is the user-check contract (ADR-0030,
  `api: 1`).
- **Interoperability.** ADR-0007 gives each other tool its own
  `interop-<tool>` package, and design §18 a `yokla export <tool>` command.
  A case's `source` already has the value `import`.

Two rules of this repository bear on the row:

- **Other evaluation tools are never named in the repository.** A package, a
  command's argument or a fixture named after a tool would name it, so
  ADR-0007's per-tool packages can't be built as written.
- **No data leaves the machine by default, and there is no telemetry**
  (ADR-0003). An action that posts to a pull request, or a site that loads a
  third-party script, would send data no run asked for.

The red-team track (ADR-0079) ran as items in order, one ADR each, each with
exit criteria on the demo-shop.

## Decision

### v0.6 is built as a track of six items, in order

Each item starts with its own ADR. Being listed here doesn't approve it.
Each item is done when its exit criteria hold on the demo-shop, in CI, at no
model cost.

| Item | Scope | Exit criteria |
|---|---|---|
| **E1. A library API** | the `yokla` package exports the CLI's steps as typed functions: load a profile, a config and cases, from files or from objects; run them; gate, compare and report. They return `results.v1` and the other schemas' objects, throw typed errors, print nothing and never end the process. The CLI's commands are built on them. A test lists the exported names, and the guide documents them | a script in the repository runs the demo-shop's suites through the API and gates them, with the statuses `yokla run` and `yokla gate` give; `pnpm pack-check` runs it from the installed tarball |
| **E2. A GitHub Action and CI recipes** | a composite action in this repository, `action.yml` at its root: it runs a pinned version of `yokla run` and `yokla gate`, writes a Markdown summary of the run to the job's summary, and keeps the reports as the job's artifact. `yokla report` writes the same Markdown summary, for any CI. The guide gains recipes for other CI systems | this repository's CI runs the action from its own checkout against the demo-shop: the correct shop passes, and a seeded defect breaks the gate with its failing case in the summary; the summary is tested as a snapshot |
| **E3. Two runs side by side** | `yokla compare` shows what changed inside a case: per case, each run's findings, check by check, as new, gone or kept; each turn's answers next to each other; cost and latency per case. The HTML report (ADR-0023) gains a comparison page. It compares any runs of the same cases: before and after a change, two targets, two profiles | on the demo-shop, the correct shop's run compared with a run under one defect names that defect's cases and checks as newly failing and shows both answers; reversed, it names them fixed; two runs of the correct shop show no change in findings |
| **E4. Export** | yokla's cases as a neutral dataset, a JSON Lines row per case; its results as neutral rows, one per turn and sample, with the status and the findings; its checks as one JavaScript assertion function on E1's API, for any tool whose assertions can be JavaScript: an answer and its evidence in, a verdict, a score and a reason out. Each format has a JSON Schema and a table of what it leaves out (ADR-0007) | the assertion function, given the turns of a demo-shop run, gives the run's own verdicts; a demo-shop run's exported cases and rows validate against their schemas |
| **E5. Import** | another tool's cases and results, read through a mapping the user writes, as a profile adapts yokla to a target (P9): which field or column holds the message, the answer, the verdict, the score and the reason. JSON, JSON Lines, CSV and YAML. Cases become proposed cases with `source: import` (ADR-0004); results become samples and findings (ADR-0007), which report and gate like yokla's own. A row whose verdict the mapping can't find is `unmeasured`, never a pass | three fixtures, each in a different shape written from a tool's published format, import with their verdicts; yokla's own exported rows (E4) import back to the same statuses; imported cases don't gate until a person approves them |
| **E6. A documentation site** | a static site built from `docs/`: the guide, the design and the ADRs, with E1's reference, its diagrams and a search built with the site. CI publishes it to GitHub Pages. No analytics, and nothing loaded from another host | CI builds the site on every push and fails on a broken link or a guide page the site lacks; a test finds nothing in the built pages that loads from another host |

### What holds for every item

- **No other tool is named in the repository.** Interoperability goes
  through neutral formats yokla documents, and through mappings the user
  writes. Fixtures are written from tools' published formats and named by
  their shape, never by the tool. yokla never runs another tool (ADR-0007).
- **No egress beyond the run's own, and no telemetry** (ADR-0003):
  - the action sends nothing outside its job: no pull-request comment, and no
    upload but the job's artifact;
  - import and export read and write files only;
  - the site loads nothing from another host.
- **The API is the CLI's own path.** A command and its function give the
  same result. There is no second runner.
- **A new published package has its name reserved by the maintainer**
  before its first release (ADR-0037, ADR-0071), and `pnpm pack-check` lists
  it.

### ADR-0007 and design §18 are amended

- **No package per tool.** An `interop-<tool>` package would name a tool.
  Interoperability lives in packages named by what they do, which E4's and
  E5's ADRs choose. The `interop-*` layer rule, `core` only, applies to them.
- **ADR-0007's other rules hold.** `results.v1` is yokla's own. Export is
  lossy, and a table documents it. An imported result becomes a sample, an
  assertion a finding, and a case carries `source: import`.
- **yokla writes no other tool's configuration file.** Design §18's
  `yokla export <tool>` goes. A user points their tool at yokla's assertion
  function (E4) and at their target, in their own configuration.

### The design is updated

- **Design §20** gains the track's table. v0.6's row gains its exit
  criteria: the demo-shop's suites run and gate through the library API and
  through the action; another tool's cases and results, in three shapes,
  import through a mapping and gate; the documentation site builds with
  nothing loaded from another host.
- **Design §18** says what this ADR says.

## Consequences

- **v0.6 ships when E1 to E6 are done** and their exit criteria hold. A
  release in between, such as 0.5.x, may carry the items done so far, and
  the package READMEs changed since 0.5.0.
- **None of the six items needs a model.** They cost nothing to build or to
  run.
- **A user of another tool maps its files once,** in a small mapping file.
  yokla ships no ready mapping for a named tool. Such a mapping may live
  outside this repository, built on E1's API.
- **The action follows yokla's releases.** `uses: thebozturk/yokla@v0.6.0`
  runs that version. Listing it on the GitHub Marketplace is the
  maintainer's choice.
- **The site needs GitHub Pages turned on** for the repository, a setting
  only the maintainer can change.
- **How the library API is versioned before 1.0** is E1's to decide.
- **Six ADRs to come,** one per item. Each may change its item's scope; a
  change of order needs a new ADR.

## Alternatives considered

- **One package per tool, named after it** (ADR-0007 as written). A ready
  mapping is easier to use, but it names the tool in the repository, and it
  must follow the tool's releases. Rejected.
- **Writing another tool's configuration file** (design §18's
  `yokla export <tool>`). It names the tool and ages with its format.
  Rejected: the assertion function and the neutral rows are what such a
  configuration needs from yokla.
- **A JavaScript action.** It needs no shell step, but its bundled code must
  be committed to the repository and built apart from the published
  packages. Rejected: a composite action runs the published CLI.
- **An action that comments on the pull request.** It is convenient, but it
  posts the run's findings, which may quote the target's answers, beyond the
  job. Rejected as a default: a user can add that step with their own token.
- **A hosted documentation service.** Its search and analytics would send
  readers' requests to a third party. Rejected: a static site on GitHub
  Pages.
- **One ADR for all of v0.6.** Too large to review in one step, as v0.5 was
  (ADR-0079). Rejected.
- **The action first,** as the most visible item. Rejected: E1 comes first,
  because the CLI moves onto it and E4's assertion function and E6's
  reference are written against it. The site comes last, because it
  documents the rest.
