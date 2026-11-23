# 0094. A GitHub Action and CI recipes (E2)

Status: Accepted · Date: 2026-11-23

## Context

ADR-0092 makes E2 a composite action in this repository, `action.yml` at
its root. It runs a pinned version of `yokla run` and `yokla gate`, writes
a Markdown summary of the run to the job's summary, and keeps the reports as
the job's artifact. `yokla report` writes the same Markdown summary, for any
CI, and the guide gains recipes for other CI systems. Its exit criteria:
this repository's CI runs the action from its own checkout against the
demo-shop; the correct shop passes, and a seeded defect breaks the gate
with its failing case in the summary; the summary is tested as a snapshot.

What exists:

- **The guide's CI page** has a hand-written GitHub Actions workflow: it
  starts the assistant, runs `npx yokla@0.5.0 run` with a cost cap and
  JUnit and HTML reports, gates against the baseline, and uploads `runs/`.
- **The reports** are the terminal summary, JUnit XML and the static HTML
  page (ADR-0023). The terminal summary names each case that didn't pass
  with its first failing finding. The HTML page and the results file hold
  the target's answers; the terminal summary and JUnit hold none.
- **The exit codes** decide a pipeline: `yokla run` exits with 2 when it
  can't run or a case is in `error`; `yokla gate` with 0, 1 or 2.
- **The library API** (ADR-0093) promises the `yokla` package's exports;
  adding to them needs an ADR.
- **This repository's own workflows** pin every action to a commit SHA.

## Decision

### The action is thin: yokla does the work

- **`action.yml` at the repository's root,** a composite action of shell
  steps. It calls `yokla run` and `yokla gate`, copies a Markdown file into
  the job's summary, and uploads the reports. It holds no logic that yokla
  itself doesn't test.
- **Every input reaches the shell through an environment variable,** never
  written into the script, so an input can't inject a command.
- **GitHub runs a bash step with `-e`.** The run and gate steps turn it off,
  so they read yokla's exit code instead of stopping at it.
- **It sets up nothing.** The job brings Node.js 24 or later, as it brings
  the assistant. The first step checks the version and fails with a clear
  message when it is older.

### Its inputs and outputs

| Input | Default | Meaning |
|---|---|---|
| `version` | this release's version | The yokla version to run, with `npx --yes yokla@<version>`. |
| `command` | | Runs yokla instead of `npx`, such as `pnpm yokla` in this repository; split on spaces. |
| `profile`, `config`, `baseline` | yokla's own defaults | Passed as `--profile`, `--config` and `--baseline`. |
| `cases`, `tags` | | One per line; each passed as `--cases` or `--tag`. |
| `target-url`, `max-cost` | | Passed to `yokla run`. |
| `args` | | Further `yokla run` arguments, one per line. |
| `working-directory` | `.` | Where yokla runs. |
| `reports` | `${{ runner.temp }}/yokla` | Where the results and the reports go. |
| `artifact` | `yokla` | The artifact's name; empty keeps no artifact. |
| `retention-days` | `7` | How long the artifact is kept. |

- **Outputs:** `verdict` (`pass`, `broken` or `unjudgeable`; empty when the
  run wrote no results), `results` (the results file) and `summary` (the
  Markdown file).
- **The default version is the release's own.** `action.yml` names it, a
  test keeps it equal to the packages' version, and a release's preparation
  raises it with them. `uses: thebozturk/yokla@v0.6.0` runs yokla 0.6.0.
- **A test, `scripts/action.test.ts`, holds the action to these rules:** the
  default version, every action it uses pinned to a commit, and no
  expression written into a script.

### Its steps

1. **Run:** `yokla run` with the inputs, writing the results, JUnit XML and
   the HTML report under `reports`.
2. **Gate:** when the run wrote results, `yokla gate` with
   `--markdown <reports>/summary.md`. When it didn't, the step writes a
   summary that says so and points at the log.
3. **Summary:** the Markdown file is appended to the job's summary.
4. **Artifact:** the reports are uploaded, also when an earlier step
   failed, with `actions/upload-artifact` pinned to a commit SHA.
5. **Verdict:** the step fails when the run exited with 2 or the gate with
   1 or 2, after the summary and the artifact are kept.

### The Markdown summary

- **`markdownReport(results, outcome?)` in `@yokla/report`** renders a run
  as Markdown: the status counts and pass rate; a table of the cases that
  didn't plainly pass, with the reason the terminal summary gives;
  advisory findings; and the run's notes, such as the model proxy's
  totals. With the gate's outcome, it opens with the verdict and lists the
  breaches, problems and notices.
- **It holds what the terminal summary holds, and no answers.** The job's
  log already shows the same. The answers stay in the results file and the
  HTML page, which only the artifact keeps.
- **The two are built from the same parts:** the counts, the case rows,
  the errors and the run's notes. The terminal summary lays them out as
  lines, the Markdown as a list, a table and a folded block, so the two
  can't drift apart.
- **It stays under GitHub's limit for a step's summary:** the table shows
  the first 100 cases, heaviest first as the terminal does, and says how
  many more there are.
- **`yokla gate --markdown <file>`** writes it with the verdict, also when
  the gate breaks or can't judge the run. **`yokla report --markdown
  <file>`** writes it without one.
- **The library API gains `markdownReport`,** by this ADR (ADR-0093).

### CI recipes

- **The guide's CI page** shows the action first, then the hand-written
  workflow for those who want every step in view.
- **Recipes for GitLab CI and Azure Pipelines:** each runs and gates,
  shows the JUnit XML in the CI's test view, and keeps the reports for a
  short time. Azure Pipelines also shows the Markdown summary on its run
  page.

### Exit criteria

- **This repository's CI has a job that uses the action from its own
  checkout** (`uses: ./`, with `command: pnpm yokla`) against two
  demo-shops: the correct one, and one with `fabricated-price`.
  - The correct shop's step passes, with the verdict `pass`.
  - The defect's step fails, with the verdict `broken`, and its summary
    names a failing case with the reason the terminal summary gives: its
    dimension, `fabrication`, and the finding. The check's id isn't in it,
    as it isn't in the terminal summary.
- **A snapshot test** holds the Markdown of a run with failing, proposed
  and advisory cases, with and without the gate's outcome.

## Consequences

- **A user's workflow is four steps:** check out, set up Node.js 24, start
  the assistant, and `uses: thebozturk/yokla@v0.6.0`.
- **The action follows yokla's releases.** It is tagged with them, and its
  default version is theirs. Listing it on the GitHub Marketplace stays the
  maintainer's choice (ADR-0092).
- **A public repository's job summary is public.** The summary holds no
  answers, but a finding's reason can quote a value from one, as the log
  does. The guide says so.
- **No new package,** so no name to reserve.

## Alternatives considered

- **The action sets up Node.js itself.** It would change the job's Node.js
  behind the user's back, for every later step. Rejected: the job sets it
  up, and the action checks it.
- **The action writes the Markdown from the terminal output.** Shell text
  munging, untested. Rejected: yokla renders it, and tests it.
- **Separate Markdown for the run and for the gate.** Two files to join,
  and the verdict apart from the cases it judged. Rejected: one function,
  with the gate's outcome optional.
- **A separate repository for the action.** The Marketplace prefers one
  action per repository, but its releases would drift from yokla's.
  Rejected: one repository, one tag, one version.
- **A Docker action.** Slower to start, and it needs an image to publish.
  Rejected: a composite action runs the published CLI.
- **The HTML report in the job's summary.** It holds the answers. Rejected:
  it stays in the artifact.
