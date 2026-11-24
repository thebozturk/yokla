# 0098. A documentation site (E6)

Status: Proposed · Date: 2026-11-23

## Context

ADR-0092 makes E6 a static site built from `docs/`: the guide, the design
and the ADRs, with E1's reference, its diagrams and a search built with the
site, published by CI to GitHub Pages, with no analytics and nothing loaded
from another host. Its exit criteria: CI builds it on every push and fails
on a broken link or a guide page the site lacks; a test finds nothing in the
built pages that loads from another host.

What exists:

- **`docs/`** holds the guide (eleven pages), the design and 98 ADRs, in
  Markdown that reads on GitHub. Pages link to each other relatively. Four
  links leave `docs/`: three JSON Schemas under `packages/cli/schemas/` and
  the demo-shop's README.
- **Diagrams are Mermaid** blocks, which GitHub draws.
- **The library API's reference** is the guide's page `api.md`
  (ADR-0093), written by hand.
- **ADR-0006 sets the tooling:** TypeScript and Node.js, pnpm, oxlint,
  Prettier, Vitest. A new tool needs an ADR. pnpm installs no release
  younger than seven days.
- **The README promises the guide** on GitHub; npm shows the README.

## Decision

### VitePress builds the site

- **VitePress 1, a root `devDependency`,** builds `docs/` as it is: Markdown
  first, relative links between pages, a sidebar, light and dark themes,
  its fonts served from the site. It is never in a published package, so
  `pnpm pack-check` doesn't change.
- **Its configuration is `docs/.vitepress/config.ts`,** type-checked and
  linted with the repository. The built site goes to
  `docs/.vitepress/dist`, which git ignores.
- **`pnpm site`** builds it, and **`pnpm site:dev`** serves it locally while
  writing.

### What the site holds

- **A home page,** `docs/index.md`, new: what yokla is, a first run, and
  where to go next.
- **The guide,** in the order of its README; **the design**; and **the
  ADRs**, listed by their index.
- **The library API's reference** is the guide's `api.md`, as ADR-0093
  made it. No reference is generated from the types: the page says what
  the names promise.
- **A link that leaves `docs/`** points to the file on GitHub, rewritten
  when the site is built, so the Markdown keeps reading on GitHub as it
  does.

### Nothing from another host

- **The search is built with the site:** VitePress's local search, its
  index a file of the site.
- **The diagrams are drawn in the browser by Mermaid,** bundled into the
  site and served from it, not from a CDN.
- **No analytics, no font service, no embed.** A link to another site is a
  link, never a load.
- **A check scans the built pages:** no `script`, `link`, `img`, `iframe`,
  `source` or `video` that loads from another host, and no `url()` or
  `@import` to one in the styles.

### CI and Pages

- **CI builds the site on every push,** in its own job, and fails when the
  build finds a link to a page that doesn't exist (VitePress's dead-link
  check), when a guide page is missing from the built site or its sidebar,
  or when the scan finds a load from another host.
- **A release publishes it to GitHub Pages:** `.github/workflows/site.yml`
  runs on a `v*` tag and on demand, with the Pages actions pinned to commit
  SHAs, so the site describes what npm holds.
- **The maintainer turns Pages on,** with GitHub Actions as its source,
  once. Until then, nothing is published, and CI still builds and checks
  the site.

### Exit criteria

- **CI's site job** builds the site from `docs/` and passes; a page linked
  to a missing file, or a guide page left out of the sidebar, fails it (a
  test of the check shows both).
- **The scan** finds nothing in the built pages that loads from another
  host, and a test shows it catching one.

## Consequences

- **The guide gains a site,** at `https://thebozturk.github.io/yokla/` once
  Pages is on, without leaving the repository or changing how its Markdown
  reads on GitHub.
- **A large development dependency tree,** VitePress and what it builds
  with, enters the lockfile. It runs only to build the site, and the
  seven-day release age holds for it.
- **The ADRs become pages:** what they record is unchanged, and an accepted
  ADR is still never edited (ADR-0006's Markdown stays hand-formatted).

## Alternatives considered

- **A generator of yokla's own,** Markdown to HTML with a template. Fewer
  dependencies, but its own search, sidebar, themes and link checking to
  write and keep. Rejected.
- **Another static-site tool in the Node.js ecosystem,** heavier on a
  framework or needing plugins for Markdown links and Mermaid. Rejected:
  VitePress reads `docs/` as it is.
- **A Python documentation tool.** It would add a second language's
  toolchain, against ADR-0006. Rejected.
- **A reference generated from the types.** It would document every
  exported type, including the parts no ADR promises. Rejected: `api.md`
  says what is promised.
- **Publish on every push to main.** The site would describe features
  before npm has them. Rejected: a release publishes it; on demand covers a
  fix to the words alone.
- **Diagrams drawn at build time,** as images. It needs a headless browser
  in the build. Rejected: Mermaid, served from the site, draws them.
