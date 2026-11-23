# yokla with other tools

yokla reaches other evaluation tools through neutral formats it documents,
never through a file of a named tool ([ADR-0092](../adr/0092-the-ecosystem-track.md)).
This page covers export ([ADR-0096](../adr/0096-export.md)): your cases as a
dataset, your runs as rows, and yokla's checks as one JavaScript function a
tool can call.

## Your cases as a dataset

```sh
npx yokla export --out cases.jsonl [--profile yokla.profile.yaml] [--cases cases] [--tag search]
```

One JSON line per case, by the schema `yokla schema case-row` prints
(`yokla.case-row/v1`):

```json
{"schema":"yokla.case-row/v1","id":"shipping-tr","suite":"factual","language":"tr","tags":[],"message":"Kargo ücretsiz mi?","turns":[{"message":"Kargo ücretsiz mi?","expect":{"policyTopic":"shipping"}}]}
```

| Field | What it holds |
|---|---|
| `id`, `suite`, `language`, `tags` | as the case has them |
| `message` | the first turn's message, for a tool that sends one message |
| `turns` | each turn's message, and its expectations as the case writes them |

**What a case row leaves out:**

| Left out | Why |
|---|---|
| A case with a simulated customer | it has no written turns; `yokla export` names it as skipped |
| A proposed or rejected case | only approved cases are written (ADR-0004); each is named as skipped |
| A turn's provider faults, tool result changes and tool description changes | they need yokla's model proxy |
| Identities and roles, a turn's `as` | they need yokla's sessions |
| Provenance, the title, samples, weight and the known gap | they are about the case, not about what to send |

## Your runs as rows

```sh
npx yokla report --results runs/<run id>.json --rows runs/rows.jsonl
```

One JSON line per turn of each sample, by the schema `yokla schema
result-row` prints (`yokla.result-row/v1`), for a tool or a dashboard that
reads rows:

| Field | What it holds |
|---|---|
| `run`, `case`, `suite`, `language`, `tags` | the run's id and the case's |
| `sample`, `turn` | their indexes |
| `message`, `answer` | what was sent, and the answer's text, `null` without one |
| `latencyMs`, `costUsd` | the turn's, `null` when not measured |
| `verdict` | the turn's: the status a sample of that one turn would get by the case's policies: `pass`, `fail` or `unmeasured` |
| `status` | the case's status in the run |
| `findings` | every finding: check, dimension, verdict, severity, message |
| `error` | why the turn couldn't be judged |

**The rows hold your assistant's answers,** as the results file does: keep
them as private.

**What a result row leaves out:** the evidence and what the model saw in
tool results, the model calls and their prompts, spans, the fields observed
in the target's logs, the aggregation of each dimension across samples, a
threshold's mean or percentile, and the run's metadata beyond its id. The
results file keeps them all.

## yokla's checks in another tool

Most tools can call a JavaScript function to judge an answer. Give them
yokla's: it judges the answer your tool got for the turn of the yokla case
its row names, with your profile's checks, catalog and policies, as a run
judges it. It sends nothing and calls no model.

```js
// judge.mjs: call it from your tool with each answer and the row it sent.
import { createAssertion, loadProject } from 'yokla';

const judge = createAssertion(await loadProject());

export async function judgeAnswer(answer, row) {
  // { pass, score, reason, verdict }
  return judge(answer, { case: row.id });
}
```

1. **Export the cases** with `yokla export`, and give the rows to your tool
   as its dataset.
2. **Let your tool send each row's `message`** to your assistant.
3. **Call the function** with the answer and the row.

What it takes:

| `answer` | Means |
|---|---|
| `{ body, status?, latencyMs? }` | the assistant's JSON body, read with your profile's response mapping: the text, the route and the evidence, so the price, stock and policy checks apply |
| a string | the answer's text alone: checks that need evidence don't apply |
| `{ text, evidence, status?, latencyMs? }` | the text and the evidence, as yokla's results hold them |

| `context` | Means |
|---|---|
| `case` | the case row's `id` |
| `turn` | the turn's index; the case's last turn by default |
| `earlier` | the answers of the turns before it, for checks that read the conversation |

What it gives:

| Field | Means |
|---|---|
| `verdict` | `pass`, `fail` or `unmeasured`, as a result row's |
| `pass` | `true` only for `pass`: `unmeasured` is never a pass |
| `score` | the share of the turn's findings that passed; 0 with none |
| `reason` | the failing findings, each `check (dimension): message`, or why the turn is unmeasured |

- **Give it the latency** when your tool measures it. Without `latencyMs`, a
  turn's `deadlineMs` is unmeasured. A check module of your own sees 0.
- **The status** is 200 unless you give another.
- **Checks that read yokla's model proxy,** its spans or your target's logs
  find nothing to read, as in a run without them.
- **It judges a turn,** not a case: your tool keeps its own samples and how
  it sums them.
