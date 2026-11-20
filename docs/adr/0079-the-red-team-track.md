# 0079. The red-team track: v0.5 in seven items

Status: Accepted · Date: 2026-11-20

## Context

Design §20 gives v0.5 its scope in one row:

- local attack generation, from templates and an attacker model, natively
  in Turkish and English;
- e-commerce attacks: price and discount manipulation, order fraud, card
  data, age and region restrictions, unauthorised commitments, competitor
  steering, hijacking, excessive agency, another customer's data, injection
  through product content and through tool descriptions, including a
  description that changes mid-conversation, and unsafe advice;
- canary-based deterministic detection, multi-turn and encoding strategies;
- findings mapped to OWASP LLM Top 10, OWASP Agentic, GDPR and KVKK, and
  the EU AI Act;
- a calibrated judge.

Its exit criteria: the demo-shop's injection, leakage and BOLA defects are
detected deterministically, and the egress test passes.

That row is too large for one ADR, and its parts depend on each other. Some
of it exists already:

- **Direct injection** has a starter case with a canary (ADR-0018).
- **System-prompt leakage** has `prompt-leak`, with a canary in the
  profile (ADR-0015).
- **Injection through a tool result** has `injection-canary`, with the
  proxy writing the instruction (ADR-0043).
- **Excessive agency** is partly covered: `tool-calls` can forbid a tool
  call (ADR-0025).
- **Robustness transforms** already rewrite an approved case's messages
  (ADR-0045, ADR-0059).

The debugging track (design §20) ran the same way: an order of items, one
ADR per item, each with exit criteria on the demo-shop, each item built on
the ones before it.

Design §22 also leaves open the default attacker and judge model.

## Decision

### v0.5 is built as a track of seven items, in order

Each item starts with its own ADR. Being listed here doesn't approve it.
Each item is done when its exit criteria hold on the demo-shop, at no model
cost unless its ADR says otherwise. The items that cost nothing come first.

| Item | Scope | Exit criteria |
|---|---|---|
| **R1. Attack cases from templates** | `yokla generate` writes attack cases from templates: the domain pack holds the attack goals, the language pack their phrasing in Turkish and English. Each case carries a fresh canary or a value the checks can find, and is written as a proposed case of the `redteam` suite. First kinds: direct injection, system-prompt extraction, price and discount manipulation, unauthorised commitments, competitor steering | every kind passes on the correct demo-shop; a new defect that agrees to a price the user names fails its case, by a deterministic check |
| **R2. Leakage and another customer's data** | seeded fake personal data and card numbers; two identities in one run; `pii-leak`; the demo-shop's orders, one set per session | the demo-shop's defect that shows another session's order (design §19, "later (v0.5)") is caught; a seeded card number or address that reaches an answer is caught |
| **R3. Multi-turn and encoding strategies** | strategies that rewrite an approved attack case, as the transforms do: an attack spread over several turns, and encodings (Base64, leetspeak, letters swapped for look-alikes, Turkish written without its letters) | an encoded or spread attack that the correct shop withstands still passes; a defect that decodes and follows one is caught |
| **R4. Injection through tools** | the proxy changes a tool's description, not only its result (ADR-0043), and can change it mid-conversation; order fraud and excessive agency judged by `tool-calls` | a defect that follows an instruction in a tool description is caught, including one that arrives on the second turn |
| **R5. An attacker model** | `models.attacker` writes variants of the template attacks and, turn by turn, adaptive multi-turn attacks, cached and capped as yokla's other own models are; detection stays deterministic | on the demo-shop, with the fake provider playing the attacker, a defect only an adaptive attack reaches is caught, and a second run repeats from the cache at no cost |
| **R6. Findings mapped to frameworks** | each attack kind and check maps to the OWASP LLM Top 10 and OWASP Agentic categories, and to the GDPR, KVKK and EU AI Act topics it touches; the reports group findings by them | every red-team finding of the demo-shop's run names its categories; the mapping is a table with tests in both directions |
| **R7. A calibrated judge** | `models.judge`, for dimensions with no deterministic check: unsafe advice, hijacking, and age and region restrictions where no rule applies; a calibration set of seeded cases in every run (ADR-0005); never gates unless the user opts in per dimension | a judge that misjudges a calibration case gives `unmeasured` for the run; with the fake provider as judge, the demo-shop's unsafe-advice defect is found and doesn't gate by default |

### What holds for every item

- **Detection is deterministic wherever a rule can decide.** A model may
  write an attack (R5) but never decides a verdict, except the judge's own
  dimensions (R7), which don't gate by default (ADR-0005).
- **A person approves every attack case** before it counts towards the gate
  (ADR-0004). Generated cases are proposed.
- **Attack ideas, not attack code.** Public taxonomies and papers may shape
  the kinds; no corpus or probe set is copied. A downloaded corpus is data,
  never executed.
- **No egress beyond the run's own.** Each item's demo-shop runs go under
  the egress test (design §15).
- **Turkish and English are written natively,** each by its language pack,
  never translated by a model at run time.
- **Each demo-shop defect is added in the item whose checks catch it,** so
  "every defect is detected" holds after each item (design §19).

### There is no default attacker or judge model

- **The user chooses each one,** as for the simulated customer (ADR-0028)
  and the analyzer (ADR-0049). Without `models.attacker`, R5's attacks are
  not written; without `models.judge`, R7's dimensions are `unmeasured`.
- **The judge must differ from the target's model** (ADR-0005). When the
  proxy sees the target's model, yokla says so if the two are the same.
- This answers design §22's fourth question.

### The design is updated

- **Design §20** gains the track's table, as it holds the debugging
  track's.
- **Design §22's fourth question** is closed by this ADR.

## Consequences

- **v0.5 ships when R1 to R7 are done** and its exit criteria hold. A
  release in between, such as 0.4.x, may carry the items done so far.
- **The first four items cost nothing to build or to run.** A model is
  needed only from R5.
- **The private target of design §19 can be tested after R1:** generated
  attack cases, approved by hand, with no model cost. Its known class
  "prompt injection" is retried there.
- **Seven ADRs to come,** one per item. Each may change the item's scope;
  a change of order needs a new ADR.

## Alternatives considered

- **One ADR for all of v0.5.** Too large to review and to test in one
  step, and its parts depend on each other. Rejected.
- **The attacker model first.** It finds more, but costs money in every run
  and depends on templates to start from. Rejected: templates first, a
  model to vary them later.
- **The judge first,** to cover the kinds no rule decides. It would judge
  with no calibration set and no demo-shop defects to calibrate against.
  Rejected: last, once the deterministic kinds are done.
- **A recommended default model,** such as a small local one. A default
  would choose where the target's answers go, and would age. Rejected: the
  user chooses, as for yokla's other models.
- **Importing another tool's attack catalog.** It would bring that tool's
  licence and its phrasings, mostly in English. Rejected: import of other
  tools' cases is v0.6's interoperability, as proposed cases.
