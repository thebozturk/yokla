# 0099. Replies cut at maxTokens, in every role of yokla's own models

Status: Accepted · Date: 2026-11-24

## Context

ADR-0090's judge ran on a real model for the first time on 2026-11-24:
Claude Haiku 5.5 through a hosted gateway, approved with its estimate,
against the demo-shop's correct shop and each of its eight judged defects,
over the 20 attack cases of the judge dimensions that
`yokla generate --redteam --per-kind 2` writes, with `models.judge.maxTokens`
at its default, 400. It made 58 calls and spent $0.0058.

- **The calibration held:** 32 of 32 items judged right, in Turkish and in
  English. No answer of the correct shop was judged `fail`, and every defect
  was found.
- **3 of the correct shop's 20 judged turns were `unmeasured`,** all three
  Turkish. Their replies stopped at `maxTokens`, inside their JSON, one with
  no text at all. The model reasons before it answers, and its reasoning
  counts against `maxTokens` (ADR-0051): the replies' output was 104 tokens
  at the median and 400 at the most, for one line of JSON.
- **A cut calibration item would have discarded the run.** One unreadable
  item makes every judge dimension of the run `unmeasured` (ADR-0090). The
  three cut replies happened to be turns, not items.
- **Nothing said they were cut.** The reason was "the judge's reply couldn't
  be read as a verdict". The cut replies were cached, so a rerun repeats
  them unless `--fresh-judge` is given, and `maxTokens` is in the cache key,
  so raising it asks every verdict anew. The terminal said "32 of 32
  calibration items judged right" and nothing of the three turns.

ADR-0051 settled this for the analyzer: a cut reply is said and never
cached, and `maxTokens` left its cache key. ADR-0072 raised its default to
2,000 and kept 400 for the customer and the transforms, since their replies
are short. The run shows that the reasoning fills the budget, not the reply.
yokla's other roles differ today:

| Role | A cut reply | Cached | `maxTokens` in the key | Default |
|---|---|---|---|---|
| analyzer (ADR-0049) | named, gives no value | no | no | 2,000 |
| transform (ADR-0059) | not sent, named | no | no | 400 |
| customer (ADR-0028) | sent cut; an error when empty | yes | yes | 400 |
| attacker (ADR-0087) | sent cut; an error when empty | yes | yes | 400 |
| judge (ADR-0090) | `unmeasured`, reason not named | yes | yes | 400 |

A customer's or an attacker's cut reply is sent to the target as the next
message, though its end is missing. The attacker hasn't run on a real model
yet; on a model that reasons it would meet the same budget.

## Decision

### One default for every role

- **`models.customer`, `models.transform`, `models.attacker` and
  `models.judge` default `maxTokens` to 2,000,** as `models.analyzer` does
  (ADR-0072, amended). A person may still set any value up to 64,000.
- **What is spent doesn't grow:** a model stops when its reply is done.
  The most it may spend does, five times: the transforms' upper bound,
  printed before their first call (ADR-0059), counts it, and `--max-cost`
  still caps every role.

### A cut reply is said, never used and never cached

ADR-0051's rule, in every role. The model client already tells whether a
reply stopped at `maxTokens`.

- **The judge:** the dimension is `unmeasured` on that turn, with the
  reason "the judge's reply stopped at maxTokens (N): raise
  models.judge.maxTokens". A cut calibration item is unreadable, as today,
  and the run issue that names the items says which were cut and the
  setting to raise.
  - *Clarified while building:* the issue gives each item without a verdict
    its reason, whichever it is: "no verdict given: " and the reason, for a
    cut reply, one that can't be read, or a failed call.
- **The attacker:** a cut reply is never sent. The case is an error, as a
  failed attacker call is (ADR-0087), and the error names the setting to
  raise.
- **The customer:** the same; its conversation ends in `error`
  (ADR-0028), naming the setting.
- **The transforms** already do this, and are unchanged.
- **Its cost counts,** toward `--max-cost` and in `run.own`, as any call's.
- **A cut reply is not cached,** and a cached reply marked cut, written
  before this ADR, is a miss. A rerun asks only for what was cut.
- **Nothing is asked again by itself** with a larger `maxTokens`: the
  person raises it (ADR-0051, ADR-0072).

### `maxTokens` leaves the cache key

- **The customer's, the attacker's and the judge's cache keys lose
  `maxTokens`,** as the analyzer's did (ADR-0051); the transforms' never
  held it. A reply read whole doesn't depend on it, so raising it after a
  cut asks only the cut replies anew.
- **The keys change once:** a cache written before this ADR answers no
  customer, attacker or judge request, and each is asked anew once.

### The summary counts the unmeasured verdicts

- **The judge's line in the terminal summary** adds the judged turns'
  verdicts left `unmeasured`, by reason, when there are any: "3 of 20
  verdicts unmeasured: 3 replies stopped at maxTokens (raise
  models.judge.maxTokens)". The Markdown summary, built from the same parts
  (ADR-0094), says the same.
  - *Clarified while building:* the count is a line under the judge's, and
    each reason a line under it, as the reason reads in the results, with
    its count: "3 of 20 verdicts unmeasured:", then "the judge's reply
    stopped at maxTokens (400): raise models.judge.maxTokens (3 verdicts)".
    When a run-wide reason, such as a misjudged calibration, already leaves
    every verdict unmeasured, the judge's line says it, and no count
    follows.
- **It is read from the cases' judge checks.** `results.v1` is unchanged.

### The demo-shop and the tests

- **The fake provider honours `max_tokens`** on its OpenAI-compatible
  endpoint already (ADR-0051).
- **The judge's end-to-end test** adds a run with `models.judge.maxTokens`
  too small for a verdict: the calibration items are cut, every verdict is
  `unmeasured`, and the run issue names `maxTokens`. The next run, with the
  default, asks them anew and judges as the advisory run does.
  - *Clarified while building:* both runs use a copy of the profile in a
    directory of its own, so a cache of their own: with `maxTokens` out of
    the key, the cache of the test's earlier runs would answer the short
    judge, and nothing would be cut.
- **Unit tests,** per role: a cut reply is neither used nor cached; a
  cached reply marked cut is a miss; the reason or error names the setting;
  a reply cached at one `maxTokens` answers a run at another; each role's
  default is 2,000.
- **The summary's count** has unit tests in the terminal and the Markdown
  summary: none when every verdict was read, and one reason per kind.
- **One run with a real model, by hand,** approved with its estimate: the
  judge trial again, with the default. No reply cut, 32 of 32 items right,
  and the three turns judged. Its results go to design §19 with the first
  run's.

## Consequences

- **No reply of yokla's own models is lost or sent cut silently.** What the
  model couldn't finish is named, with the setting that fixes it.
- **A cut on a model that reasons is rarer,** at five times the budget.
  When it happens, a rerun after raising `maxTokens` asks only the cut
  replies.
- **Upper bounds grow:** the transforms' printed bound, and any estimate
  that counts calls × `maxTokens`, is five times today's for the same calls.
- **Every customer, attacker and judge reply cached before this ADR is
  asked anew once.** A cassette of the target's calls (ADR-0040) is not a
  cache of yokla's own, and is unchanged.
- **An attack case can end in an error** where it ran on today, with a cut
  message. A cut attack isn't the attack the strategy wrote, so its verdict
  meant little.
- **Not in this ADR:** six of the demo-shop's eight judged defects answer
  with the message and answer of one of yokla's own calibration items, so on
  the demo-shop they show nothing beyond the calibration. Answers of their
  own are a separate item.

## Alternatives considered

- **A larger default for the judge only.** The attacker and the customer
  run on the same client and the same kind of model, and the attacker's
  trial is next. Rejected: one rule for every role.
- **1,000 rather than 2,000.** Nothing measured says 1,000 holds; 2,000 is
  the analyzer's, measured on the same model. Rejected.
- **Asking again with a larger `maxTokens`, by itself.** It would spend
  beyond the estimate the person approved (ADR-0051). Rejected.
- **Turning the model's reasoning off, or lowering its effort.** Not every
  provider offers it, the setting differs by kind and by model, and the
  reasoning may be what judges well (ADR-0051). Rejected.
- **Sending an attacker's or a customer's cut reply,** as today. Its end is
  missing, so the target answers a message the strategy or the persona
  didn't write. Rejected.
- **Keeping `maxTokens` in the cache key,** to keep today's caches. Then
  raising it after a cut asks every reply anew. Rejected: the caches are
  asked anew once instead.
- **A count of unmeasured verdicts in `results.v1`.** The cases' judge
  checks already hold them. Rejected: the summary reads them there.
