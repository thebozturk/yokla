# Commands, configuration and the gate

From a checkout of the repository, run each command as `pnpm yokla <command>`.
`yokla <command> --help` prints its options.

| Command | Does |
|---|---|
| `init` | Writes a first profile and starter cases from one message to the target. |
| `run` | Runs cases against the profile's target and writes a results file. |
| `report` | Prints the summary of a results file, and optionally writes JUnit XML. |
| `gate` | Judges a results file against thresholds and a baseline. |
| `baseline` | Accepts a run as the baseline. |
| `proxy` | Runs the model proxy until stopped. |
| `plan` | Estimates the cost of a run from an earlier one. |
| `schema <name>` | Prints a JSON Schema: `profile`, `cases`, `config`, `results` or `baseline`. |

## `yokla init`

```sh
pnpm yokla init --url <url> [--body <json>] [--header 'name: value']... \
  [--session-url <url>] [--text <jsonpath>] [--language tr|en]... [--dir <path>] [--force]
```

| Option | Default | Meaning |
|---|---|---|
| `--url <url>` | | The target's chat endpoint. Required. |
| `--body <json>` | `{"message": "{{message}}"}` | The request body, with the profile's placeholders. |
| `--header <name: value>` | | A request header; repeatable. Values may use `{{env.NAME}}`. |
| `--session-url <url>` | | A request that opens the target's session, a path or a URL. Its id goes to every turn as `{{carry.session}}`. |
| `--text <jsonpath>` | | Where the answer text is, for a JSON answer, when init doesn't find it. |
| `--language <tr\|en>` | `en` | A language of the profile; repeatable. The probe is written in the first. |
| `--dir <path>` | `.` | Where to write the files. |
| `--force` | | Overwrite existing files. |

It sends the target one message, and one more with `--session-url`, and
contacts nothing else. yokla makes no model call; the target may make its
own. It writes `yokla.profile.yaml`, `cases/starter.yaml` (proposed cases)
and the `.gitignore` entries, after loading both files as `yokla run` would.
It exits with `0` when the files were written, and with `2` when the probe
failed, the answer couldn't be read, a file exists without `--force`, or an
option is wrong. Then nothing is written. See ADR-0018.

## `yokla run`

| Option | Default | Meaning |
|---|---|---|
| `--profile <file>` | `yokla.profile.yaml` | The profile. |
| `--cases <path>` | `cases`, next to the profile | A case file or directory; repeatable. |
| `--out <file>` | `runs/<run id>.json` | Where to write the results. |
| `--samples <n>` | 1 | Samples per case, when the case doesn't say. |
| `--concurrency <n>` | 1 | Cases run in parallel. Serial correlation needs 1. |
| `--target-url <url>` | the profile's | Use this url instead of `target.request.url`. |
| `--junit <file>` | | Also write a JUnit XML report. |
| `--config <file>` | `yokla.config.yaml`, when present | Prices and thresholds. |
| `--proxy-url <url>` | `127.0.0.1` on `modelProxy.port` | Where the model proxy is. |
| `--max-cost <usd>` | | Start no new sample once the model cost reaches this. Needs a proxy. |

It exits with `0` when every case ran, whatever the verdicts: the gate judges
them. It exits with `2` for a configuration problem, or when a case ended in
`error`.

The results file (`results.v1`) holds every turn: the answer, the evidence,
the checks with their findings, timings, and the model calls with their cost.
Keep it out of version control when the answers may hold personal data.

## `yokla report`

```sh
pnpm yokla report --results runs/<run id>.json [--junit runs/junit.xml]
```

Prints the summary again from the results file alone, and optionally writes
JUnit XML. Neither report contains the target's answers.

## The configuration file

`yokla.config.yaml` holds what judges a run, as opposed to what reaches the
target. The [JSON Schema](../../packages/cli/schemas/config.v1.schema.json)
gives every field.

```yaml
version: 1
gate:
  maxFailures: 0
  latencyP95Ms: 8000
  suites:
    perf: { latencyP50Ms: 2000, latencyP95Ms: 4000 }
    resilience: { allowUnmeasured: true }
prices:
  openai:
    gpt-x: { input: 0.10, output: 0.50 }
plan:
  upperBoundFactor: 2
```

- **`gate`:** the thresholds below, for every suite or per suite.
- **`prices`:** per upstream id and model, in USD per million tokens (see the
  [model proxy](model-proxy.md#prices-and-cost)).
- **`plan.upperBoundFactor`:** what `yokla plan` multiplies its estimate by.

### Gate thresholds

| Threshold | Default | Breaks the gate when |
|---|---|---|
| `maxFailures` | 0 | The suite has more `fail` cases. |
| `allowUnmeasured` | `false` | The suite has an `unmeasured` case or threshold, unless this is `true`. |
| `latencyP50Ms`, `latencyP95Ms` | | The median or 95th percentile latency of the suite's answered turns, every sample included, is higher. |
| `costPerTurnUsd` | | The mean model cost of an answered turn is higher. |
| `costUsd` | | The suite's total model cost is higher. |

A threshold without data is unmeasured: no answered turn for latency, or a
turn without a cost. Values under `gate.suites.<suite>` override the
gate-wide ones for that suite.

## `yokla gate`

```sh
pnpm yokla gate --results runs/<run id>.json [--baseline yokla.baseline.json] [--config yokla.config.yaml]
```

| Exit code | Meaning |
|---|---|
| `0` | The gate passed. |
| `1` | The gate is broken: a threshold was breached, or a case that passes in the baseline fails now. |
| `2` | The run can't be judged: it is partial, a case ended in `error`, or a file couldn't be read. |

- **Baseline comparison:** a case is compared only while its definition is
  unchanged (ADR-0011).
- **Notices:** the gate also notes a `gap-closed` case, whose `knownGap`
  marker can go, and a baseline made with another profile.

## `yokla baseline`

```sh
pnpm yokla baseline --results runs/<run id>.json [--out yokla.baseline.json] [--dry-run]
```

Writes `yokla.baseline.json` from a run, and shows what changed from the
previous baseline. The file is small enough to commit. It refuses a run the
gate can't judge. `--dry-run` shows the changes without writing.

## `yokla proxy`

```sh
pnpm yokla proxy --profile yokla.profile.yaml [--port <n>] [--records <file>]
```

- **What it runs:** the model proxy from the profile's `modelProxy`, on
  `127.0.0.1` only, until Ctrl-C.
- **`--port`:** overrides `modelProxy.port`; `0` picks a free port.
- **`--records`:** appends each recorded call to a JSON Lines file, with
  prompts kept as `modelProxy.prompts.store` says.
- **Exit code `2`:** for a profile without `modelProxy`, a bad port or a port
  in use.

See the [model proxy guide](model-proxy.md).

## `yokla plan`

```sh
pnpm yokla plan --cases cases --calibration runs/<run id>.json [--samples <n>] [--config yokla.config.yaml]
```

- **What it estimates:** what running the cases would cost, from a
  calibration run made with the model proxy. It contacts nothing.
- **What it prints:** the estimate, an upper bound, and how many cases had
  their own calibration.
- **Exit code `2`:** when the calibration can't support an estimate. It then
  says what is missing and gives no figure.
