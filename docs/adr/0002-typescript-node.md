# 0002. TypeScript on Node.js; targets are tested over HTTP

Status: Accepted · Date: 2026-11-09

## Context

Most LLM evaluation and red-teaming tools are written in Python. yokla tests
assistants through their external interface, starting with HTTP, and runs a
local model proxy.

## Decision

- yokla is written in **TypeScript** in strict mode, with no `any`, on
  **Node.js LTS (minimum 24)**, as ES modules. The repository is a **pnpm
  workspace**.
- Users don't need to write TypeScript. They use the CLI with YAML/JSON
  profiles and cases, and yokla reaches the target over HTTP. Only pack authors
  write TypeScript.

## Consequences

- The language the target is written in doesn't matter: Python, Java and .NET
  assistants are tested the same way.
- yokla is distributed through npm (`npx yokla`). A standalone binary can come
  later.
- The model proxy, an HTTP server with streaming passthrough, fits Node's
  strengths.
- yokla's checks can be reused by JavaScript-based evaluation tools
  (design §18).
- Python-native users who want an in-process adapter will need a thin Python
  shim that calls the CLI or talks to a local yokla server. This is deferred.

## Alternatives considered

- **Python.** It has the larger evaluation ecosystem and in-process access to
  Python-based assistants. Rejected for three reasons: the author's expertise is
  TypeScript; interoperating with JavaScript-based tools would be harder; and testing over
  HTTP removes most of the benefit of in-process access.
- **Go or Rust.** They give a single binary and a fast proxy, but have a small
  LLM-tooling ecosystem and fewer potential contributors in this space.
  Rejected.

## Note

2026-11-10: the names of other tools were removed from the context at the
maintainer's request, as a one-time exception to the rule that accepted ADRs
are never edited. The decision is unchanged.
