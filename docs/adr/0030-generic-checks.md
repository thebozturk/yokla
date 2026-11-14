# 0030. Generic checks: patterns, JSON Schema, similarity, and checks the user writes

Status: Proposed · Date: 2026-11-14

## Context

yokla's checks know e-commerce well and other domains little. Any assistant,
whatever its domain, can be judged on four more things:

- **its wording,** by patterns: a placeholder left in an answer, an internal
  hostname, a stack trace;
- **its contract,** by a JSON Schema: the shape of its response, or of a part
  of it;
- **how close it stays to a reference answer,** by similarity;
- **a rule only its team knows,** by a check the team writes.

v0.3 plans these as generic checks.

Today `answer-text` matches phrases the turn lists, folded by the language
pack: `contains`, `notContains` and `notEmpty`. A check sees the answer's text,
route and evidence, never the response as it came. Packs, the only way to add
checks, are loaded from `yokla.config.yaml`, and today only first-party ones.

## Decision

### Patterns

- **A turn's answer can be held to regular expressions.**
  `expect.answer.matches` lists patterns the answer must match, and
  `notMatches` patterns it must not. `answer-text` judges them, with its
  phrases.

  ```yaml
  expect:
    answer:
      matches: ['\d+ gün']
      notMatches: [{ pattern: 'https?://[\w.-]*\.internal\b', flags: i }]
  ```

  - A pattern is a JavaScript regular expression, always with the `u` flag.
    The object form adds `i`, `m` or `s`.
  - Patterns see the answer as it came, not folded: folding changes the
    characters a pattern is written for. Phrases stay the way to match
    across Turkish casing and diacritics.
  - Every pattern compiles when its file loads. An invalid one refuses the
    file.
- **The profile can hold rules for every answer.** `everyAnswer.notContains`
  and `everyAnswer.notMatches` apply to every turn with a usable answer, in
  every case.

  ```yaml
  everyAnswer:
    notMatches: ['\{\{\s*\w+\s*\}\}', '\bundefined\b', 'NaN']
  ```

  - Only rules an answer must not break belong there. What an answer must
    say depends on the question.
  - A finding says whether its rule came from the profile or the turn.

### JSON Schema

- **A response can be held to a schema.** The check is `json-schema`, in the
  dimension `contract`.
  - `target.response.schema` in the profile applies to every turn with a
    usable answer.
  - `expect.schema` applies to one turn. It is a list, for several parts.

  ```yaml
  target:
    response:
      schema: { at: '$.data', schemaFile: ./schemas/reply.schema.json }
  ```

- **`at` says what is validated.**
  - It is a path in the JSONPath subset the profile already uses, `$` by
    default.
  - It reads the response document: the JSON body, or the document an event
    stream or a WebSocket becomes (ADR-0016, ADR-0024).
  - Every value the path selects must match the schema. A path that selects
    nothing fails: the contract says the part is there.
- **The schema is given inline, as `schema`, or as `schemaFile`.** A file is
  read relative to the file that names it, when it loads.
- **yokla validates a subset of JSON Schema 2020-12 itself, in core.**

  | Kind | Keywords |
  |---|---|
  | Any value | `type`, `enum`, `const`, `allOf`, `anyOf`, `oneOf`, `not` |
  | Objects | `properties`, `required`, `additionalProperties`, `minProperties`, `maxProperties` |
  | Arrays | `items`, `prefixItems`, `minItems`, `maxItems`, `uniqueItems` |
  | Strings | `minLength`, `maxLength`, `pattern`; `format` for `date-time`, `date`, `time`, `email`, `uri` and `uuid` |
  | Numbers | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` |
  | References | `$ref` to `#/...` in the same schema, `$defs` |
  | Annotations, read and ignored | `$schema`, `$id`, `$comment`, `title`, `description`, `examples`, `default`, `deprecated`, `readOnly`, `writeOnly` |

  - Any other keyword, another `format`, or a `$ref` outside the schema
    refuses the schema when it loads, with the keyword and where it is. A
    keyword yokla can't check never passes silently.
  - A `$ref` is never fetched (ADR-0003).
- **A finding names each broken rule: its path and its keyword,** such as
  `$.data.products[0].price: type, expected number`. It never copies the
  value. The first 10 are kept.

### Similarity

- **An answer can be held close to, or away from, reference answers.**
  `expect.similar` gives the references and a bound. The check is
  `answer-similarity`, in the dimension `similarity`.

  ```yaml
  expect:
    similar: { to: ['İade süresi teslimattan sonra 14 gündür.'], min: 0.6 }
  ```

  - With `min`, the answer passes when it scores at least `min` against one
    reference.
  - With `max`, it passes when it scores at most `max` against every one, for
    an answer that must not be, for example, the fallback text.
  - `min` or `max` is required. There is no default: a threshold must be
    chosen for the case.
- **The score is the cosine similarity of character trigrams.**
  - Both texts are folded by the case's language pack, and every run of
    characters that are neither letters nor digits becomes one space.
  - Trigrams follow word stems through suffixes, which matters in Turkish.
    The score needs no model and gives the same number every time.
  - Every finding carries the score, rounded to three decimals, so a
    threshold can be set from real answers.
- **It measures wording, not meaning.** A paraphrase scores low. Similarity by
  meaning needs a model, and comes with the judge (v0.5) under ADR-0028's
  rules for yokla's own model calls.

### Checks the user writes

- **`yokla.config.yaml` lists check modules.**

  ```yaml
  checks:
    - ./checks/no-internal-ids.ts
  ```

  - A path is relative to the config file. A module is JavaScript, or
    TypeScript that Node.js runs as it is.
  - The profile and case files can never name a module. `yokla init` writes a
    profile, and the analyzer (v0.4) will too: a file a machine writes must
    never run code.
- **A module's default export is a check, by contract version 1.**

  ```ts
  export default {
    api: 1,
    id: 'no-internal-ids',
    description: 'The answer shows no internal product id.',
    dimension: 'answer-content',
    run(turn) {
      const found = turn.answer.text.match(/\b[A-Z]{3}-\d{3}\b/u);
      return {
        findings: [
          found === null
            ? { verdict: 'pass', message: 'no internal id' }
            : { verdict: 'fail', message: `shows ${found[0]}`, severity: 'medium' },
        ],
      };
    },
  };
  ```

  - **`id`** is kebab-case and differs from every built-in check and from
    every other module's.
  - **`dimension`** is where its findings count. A dimension of its own may
    set `policy`: `worst-of-n` by default, `majority-of-n`, or `advisory` to
    try a check without letting it decide a case. A built-in dimension keeps
    its own policy.
  - **`expect`,** optional, is a JSON Schema in the subset above. A case then
    gives the check a value as `expect.custom.<id>`, validated by it when the
    case loads.
- **What `run` gets** is a copy of the turn, frozen, made for this contract,
  never yokla's internal view:
  - the case's `id`, `suite` and `language`, and the turn's index;
  - the user's message, and the check's own `expect` value, if any;
  - the answer: its status, latency, text, route and evidence;
  - the earlier turns of the sample, as message and answer text.

  A later field is only ever added. Changing or removing one needs a new
  contract version, and an ADR.
- **What `run` returns.**
  - It returns `{ applicable: false, reason }`, or findings, each with
    `verdict` `pass` or `fail`, a `message`, and optionally `severity`
    (`medium` by default) and `evidence`.
  - An applicable result needs at least one finding: a check can't apply and
    say nothing.
  - `run` is synchronous. A check is a function of the turn, and its verdict
    can't wait on the network.
- **When a check goes wrong.** An exception, or a result outside the contract,
  becomes an error finding, as for a built-in check. The run goes on.
- **The results name each module,** with its id, its path relative to the
  config file, and the SHA-256 of its file. A changed check shows between
  two runs.
- **Trust.** A module runs in yokla's process with the user's permissions, as
  a test file does. yokla doesn't sandbox it. It loads only what the config
  names, and nothing ever installs a module.

### The demo-shop

- **Two new defects, each caught only by a generic check.**
  - `unfilled-template`: an answer keeps a template placeholder. The demo-shop
    profile's `everyAnswer.notMatches` catches it.
  - `missing-contract-field`: the response drops a field its documented shape
    requires, one no other check reads. The profile's `target.response.schema`
    catches it.
- **An example check, `examples/demo-shop/checks/no-internal-ids.ts`,**
  catches a third defect, `internal-ids`: product ids shown in the answer.
  The end-to-end test loads it through a config, as a user would.
- **Similarity gets cases but no defect of its own.** It measures wording,
  and the existing defects that change an answer's wording are caught by
  narrower checks.
- With every defect off, every suite still passes.

## Consequences

- **yokla can judge an assistant in any domain** on its wording, its
  contract, its closeness to reference answers, and its team's own rules,
  with no model and at no cost.
- **The user check contract is a public API,** before the library API of
  v0.6. It is kept small and versioned, and it changes only by an ADR.
- **Some valid schemas won't load** until the subset grows, because an
  unchecked keyword is refused rather than ignored.
- **Similarity thresholds are set per case.** The reported score is there to
  set them. A paraphrase that a person would accept can fall below a bound.
- **A pattern can backtrack badly on a hostile answer.** yokla can't stop a
  regular expression midway. Answers are capped by the response size limit,
  and patterns are the user's own.
- **A user check can do anything the user can.** Naming a module in the
  config is the trust decision, as running a test file is.

## Alternatives considered

- **A JSON Schema library.** It covers more keywords. But it adds
  supply-chain surface, as OpenTelemetry's libraries would have (ADR-0029),
  and some libraries generate code at run time. The subset is small and
  testable. Rejected; a needed keyword is added to the subset.
- **Similarity by embeddings.** It is closer to meaning, but it needs a model:
  cost, and data leaving the machine for a hosted one. Deferred to the judge
  (v0.5).
- **A word-level score, such as word overlap.** Turkish suffixes make the
  same stem count as different words. Rejected for character trigrams.
- **Patterns on the folded text.** Folding changes the characters and their
  positions that a pattern is written for. Rejected; phrases already fold.
- **Check modules named in the profile.** The profile is data that machines
  write and people review. It must never run code. Rejected.
- **User checks as domain packs.** A pack's interface is internal and broad,
  and it isn't designed for others yet (v0.6). Rejected for now; the check
  contract is the smaller promise.
- **Asynchronous user checks.** They would let a verdict wait on a network
  call, and depend on it. Rejected.
- **A sandbox for user checks.** Node's `vm` module is not a security
  boundary, and a worker still runs with the user's permissions. Rejected;
  the config is the trust decision.
