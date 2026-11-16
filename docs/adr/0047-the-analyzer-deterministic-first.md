# 0047. The analyzer, deterministic first: inventory, data and probes

Status: Proposed · Date: 2026-11-16 · Amends 0034

## Context

Today a person writes the profile. `yokla init` (ADR-0018) helps with one
probe: it finds where the answer is, and leaves everything else to the
person. The rest takes reading the target's repository: where its catalog is
and what each field holds, which policies it has a source for, where the
products are in an answer, how to bypass its cache, what it refuses.

Design §8 plans the analyzer for v0.4, in four steps:

1. an inventory, deterministic;
2. extraction by a model, budgeted, each entry pointing to its evidence;
3. probes of the live target;
4. a review, where every new entry is `proposed`, and a rerun gives a diff.

Its exit criterion (design §20): "on demo-shop the analyzer reproduces the
approved entries of the hand-written profile (precision and recall
reported)". The maintainer chose to build it in two steps:

- **This ADR, deterministic first:**
  - the inventory;
  - the entries the target's own data and a few probes give;
  - the file the proposal is written to;
  - the measure against a profile, at no model cost.
- **A later ADR:** extraction by a model from code, docs and prompts, judged
  by the same measure.

Several entries of the demo-shop's hand-written profile need no model:

- **The catalog.** `data/catalog.jsonl` gives the catalog's path and fields:
  `id`, `category_path`, `price`, `currency`, `stock`, `name_tr` and
  `name_en`. Its types are paths with `/`.
- **The return policy.** `data/faq.jsonl` holds questions and answers on
  returns.
- **The products in an answer.** An answer that lists products holds the
  catalog's values: its id, its type as `category`, its price as
  `price.amount` and its stock as `stockQuantity`. Where they are can be
  found by matching the answer's values to the catalog's, not by guessing
  from key names.

Two rules bound what the analyzer may take from where (ADR-0004):

- **Code, data and probes answer measurability questions:** where a field
  is, how to reach the target.
- **Expectations come from claims and data,** never from the target's code
  or answers. A response contract taken from the target's own answers would
  make today's answers tomorrow's expectations.

## Decision

### The command

```sh
yokla analyze --dir examples/demo-shop --url http://127.0.0.1:3000/v1/chat \
  --body '{"message": "{{message}}", "sessionId": "{{session}}"}' \
  [--header <name: value>]... [--session-url <url>] [--language <code>]... \
  [--out yokla.profile.proposed.yaml] [--profile yokla.profile.yaml] \
  [--json <file>] [--max-files 5000] [--force]
```

- **The request is the person's,** as with `yokla init` (ADR-0018): the
  url, the body, the headers, the session url and the languages. They go into
  the proposal as given, written by a person.
- **`--dir`** is the target's repository, `.` by default.
- **yokla makes no model call.** The target may make its own, as `yokla
  init` says before it sends. The analyzer contacts only the target's urls
  (ADR-0003).

### The inventory

- **It walks `--dir`.** It skips:
  - version control and dependency folders (`.git`, `node_modules`,
    `vendor`, `.venv`), build output (`dist`, `build`, `coverage`) and other
    hidden folders;
  - links that lead out of the folder, binary files, and files over 5 MB;
  - **yokla's own files:** `yokla.profile*.yaml`, `yokla.config.yaml`,
    `yokla.baseline.json`, `runs/`, `yokla-data/`, and case files (YAML or
    JSON whose top level holds `version` and `cases`). The analyzer never
    reads the profile it is measured against.
- **It sorts each file into a kind:**

  | Kind | What it is |
  |---|---|
  | `data` | `.jsonl`, `.json` or `.csv` whose rows are objects |
  | `contract` | OpenAPI or JSON Schema: a top-level `openapi`, `swagger` or `$schema` |
  | `prompt` | a file whose name holds `prompt`, or one in a `prompts` folder |
  | `doc` | `README*`, `*.md`, and files in `docs` |
  | `env-example` | `.env.example`, `.env.sample` and the like |
  | `manifest` | `package.json`, `pyproject.toml`, `requirements*.txt`, `go.mod` |
  | `code` | source files, by their extension |
  | `other` | everything else |

- **Bounds.** `--max-files` caps the files listed, 5,000 by default; at the
  cap the analyzer stops listing and says so. A data file is read up to its
  first 10,000 rows.
- **What it shows.** Each file's path, kind and size, on the terminal and in
  the `--json` report. Never its content.

### What it proposes from the target's data

A domain pack may offer a data analyzer (P7). It gets the inventory's data
files, parsed into rows, and proposes entries with the source `data`. The
e-commerce pack proposes:

- **The catalog.** A data file whose rows have a unique id-like key and a
  positive numeric price-like key is a catalog.
  - **What makes a key id-like or price-like:** the pack's lists of key
    names, in Turkish and English (`id`, `sku`, `product_id`; `price`,
    `fiyat`; …), and the types of the values.
  - **What it proposes:** `ecommerce.catalog` with `kind: file`, the path,
    and the fields `id`, `type`, `price`, `currency` (three capital
    letters), `stock` (whole numbers or null), and `name`: one field, or one
    per language (`name_tr`, `name_en`).
- **The type separator.** `typeSeparator` is proposed when every type holds
  the same one of `/` or `>`.
- **The languages,** when the person gives none. They are those of the
  per-language name fields whose language pack is loaded.
- **The policies.** A data file whose rows have question-like and
  answer-like keys is a FAQ.
  - For each policy topic the pack's lexicon knows (returns, shipping,
    warranty), a FAQ whose rows speak of the topic gives `{ source: faq,
    path }`.
  - A topic no data file speaks of gives `{ source: none }`. Its evidence
    says that no data file speaks of it, and the person decides whether that
    is so.
- **The domain.** `domain: ecommerce`, when the pack found a catalog.
- **The evidence** names the file, and for a field its key and the rows it
  holds for: "data/catalog.jsonl: price, a positive number in 41 of 41
  rows".

### What it proposes from probes

After the data, the analyzer sends at most three messages to the target, in
one session, and prints them before it sends. Their entries have the source
`probe`.

- **Probe 1, a greeting,** as `yokla init` sends it. It is read by init's
  rules (ADR-0018): `response.text`, `response.route`, `session.carry`, and
  an event stream's document.
- **Probes 2 and 3, the pack's intents (ADR-0044),** only when the pack found
  a catalog:
  - one asks for a type of the catalog;
  - the next puts the first product shown in the cart.
- **Evidence by the data, in core.** In each answer's JSON, core looks for
  arrays of objects whose items hold a catalog row's id.
  - **The collection.** Such an array's path is proposed as the `items` of a
    collection.
  - **Its fields.** For each catalog field, core proposes the item key whose
    value equals the matched row's value, in every matched item.
  - **What isn't proposed:** a match made only by null, or by a value that
    two catalog fields share.
  - **Names.** The pack names the collections and their fields: `products`
    from the type intent, and `cart` from the cart intent.
- **The evidence** names the probe and the match: "probe 2: $.data.products[*]
  .price.amount equals the catalog's price in 3 of 3 items".

### What it doesn't propose yet

- **Entries from code, prompts and docs:** the cache bypass, rate limits,
  capabilities, canonical refusals, the facts never to fabricate, the
  patterns no answer may hold. They come with extraction by a model, in a
  later ADR, into the same file. That ADR also handles an entry that only
  code defines, as `claim: implicit` (ADR-0004).
- **A response contract.** Contracts are inventoried, and read later. A
  contract is never taken from the target's own answers (ADR-0004).

### The proposed file

- **`--out` names it,** `yokla.profile.proposed.yaml` by default. An existing
  file is never overwritten without `--force`. The analyzer never writes
  `yokla.profile.yaml`.
- **It is a profile with a `provenance` map at its top.**

  ```yaml
  provenance:
    /ecommerce/catalog/path:
      { source: data, evidence: 'data/catalog.jsonl: 41 rows', status: proposed }
    /target/response/evidence/products/fields/price:
      { source: probe, evidence: 'probe 2: ...', status: proposed }
  version: 1
  target: { ... }
  ```

  - Each key is a JSON Pointer (RFC 6901) to an entry of the file. The value
    is a provenance, as design §7 defines it.
  - The entries the person gave carry none: they are the person's.
  - A comment at the top of the file says how to approve an entry.
- **The profile schema gains `provenance`,** additively (profile.v1). A
  pointer that leads to no entry refuses the file when it loads.
  `capabilities[].provenance` stays as it is.
- **A proposed profile doesn't run.** Every command that reaches the target
  with a profile refuses one whose map holds a `proposed` or `rejected`
  entry, and names the entries: `yokla run`, `explore`, `shrink` and `mcp`.
  - A person approves an entry by setting its status to `approved`, or by
    deleting its line in the map, which makes the entry theirs (design §7).
  - They reject one by deleting the entry and its line.

### The comparison with a profile

With `--profile`, or `yokla.profile.yaml` when present, the analyzer compares
its proposal with that profile.

- **Entries are leaves:** a pointer to a scalar, or to a list of scalars,
  which is compared as a set. A list of objects is compared item by item.
- **Left out:** the person's own inputs (the request and `--language`), and
  the other profile's entries that aren't approved.
- **Each entry is one of:**
  - **`same`:** the profile has the same value at that pointer;
  - **`different`:** it has another value there;
  - **`new`:** it has nothing there;
  - **`missed`:** the profile has an approved entry the proposal lacks.
- **Two ratios:**
  - precision: same ÷ (same + different + new);
  - recall: same ÷ (same + different + missed).
- **The report.** The terminal and the `--json` report list each group and
  give both ratios.
  - The report's schema is `yokla.analysis/v1`, generated like the others
    (ADR-0008).
  - It holds the inventory, the probes (message, status, and the shape of
    the answer, without its values), the entries with their provenance, and
    the comparison.
- **This is the measure of v0.4's exit criterion.** The later extraction ADR
  is judged by it too.

### Layers

- **`core`:**
  - the profile's entries and pointers, and the `provenance` map with its
    checks;
  - the comparison;
  - the evidence matched against known rows, which knows no domain;
  - the analysis report's schema.
- **`packs/ecommerce`:** the data analyzer, and the intents it already has.
- **`@yokla/analyzer`,** a new package that depends on `core` and `runtime`
  (design §6):
  - the inventory, on the file system;
  - the probes, through `runtime`'s HTTP client;
  - putting the proposal together.
- **`cli`:**
  - `yokla analyze`;
  - the refusal of proposed entries where a command loads a profile.
- **Published with the others,** at one version: nine packages. `pnpm
  pack-check` and the release order gain it, after `@yokla/runtime` and
  before the CLI. This amends ADR-0034's list of eight. The rest of ADR-0034
  stands.

### The demo-shop

- **The end-to-end test** runs `yokla analyze --dir examples/demo-shop`
  against the demo-shop in process, with the hand-written profile's request.
  It compares the proposal with `examples/demo-shop/yokla.profile.yaml`.
  - **What it pins:** the `same`, `different`, `new` and `missed` entries,
    and the printed precision and recall.
  - **Expected `same`:**
    - the response's text and route, and the session mode;
    - the product evidence the probed type shows (id, name, category, price,
      currency, stock and colour), and the cart's;
    - the catalog and its type separator, the languages and the domain;
    - the returns policy from the FAQ, and shipping and warranty as `none`.
  - **Expected `missed`:**
    - the size and gender of products, which the probed type doesn't have;
    - the limits, the cache bypass, the response contract, the capabilities,
      the canonical refusals, `everyAnswer` and `neverFabricate`. These are
      what extraction by a model must add.
  - **The inventory** never lists the hand-written profile, its cases or its
    configuration.
  - **Gating:** `yokla run` refuses the proposed file. With every status set
    to `approved`, the file loads.
  - **Repeats:** two analyses write the same file.
- **No new defect.** The analyzer finds no defect; it writes the profile
  that finds them.

## Consequences

- **A first profile comes from the repository and the live target,** at no
  model cost, beyond what `yokla init` finds. The measure says how far it
  got.
- **Nothing leaves the machine** but the probes to the target. The analyzer
  reads the person's repository locally and sends none of it anywhere.
- **A proposed profile can't run by mistake.** Approving takes one edit per
  entry.
- **Recall stays low until code and docs are read.** This step must get
  precision right: every entry it proposes should be one a person would
  write.
- **Entries from probes are measurability, never expectations.** They say
  where a value is, not what it must be.
- **profile.v1 gains `provenance`** additively.
- **A ninth package** is published, built and checked like the others.

## Alternatives considered

- **Reading the hand-written profile for hints.** It is the measure; reading
  it would make the measure mean nothing. Rejected: yokla's files are left
  out of the inventory.
- **Field roles by key names alone,** as `yokla init` finds the answer text.
  Key names vary from one target to the next; a value equal to the
  catalog's is evidence. Key names are used for the catalog itself only,
  where no other evidence exists. Rejected for answers.
- **A response contract from the probes' answers.** It would encode the
  target's behaviour as its contract (ADR-0004). Rejected; contracts come
  from contract files, in a later ADR.
- **A provenance field on each profile object,** as `capabilities` has. Every
  schema object, and every pack's section, would need one. Rejected for one
  map by pointer.
- **Proposed entries that run, with a warning.** Machine-made entries would
  steer a run nobody approved (ADR-0004). Rejected.
- **Writing into `yokla.profile.yaml`.** Machine-made entries would mix with
  approved ones in one file. Rejected by the maintainer for a file of its
  own.
- **The analyzer's code in the CLI package.** Design §6 gives the analyzer
  a layer of its own, and extraction by a model will make it grow. Rejected.
- **More probes,** one per intent the pack has. On a paid target each costs
  the target's model calls. Three give the mapping. Rejected.
- **Extraction by a model in this ADR.** Chosen by the maintainer for later,
  so the deterministic part is measured first and the model's share shows
  apart.
