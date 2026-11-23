# @yokla/core

The core of [yokla](https://www.npmjs.com/package/yokla): the schemas of the
profile, cases, configuration, results and baseline, the check API, aggregation
and the gate; the attack cases that need no domain, the mapping of attack kinds
and checks to frameworks with the risk score, and the judge's rubrics and
calibration items.

It is pure: no I/O, no network and no `process`. Domain and language packs
depend only on it.

- `@yokla/core` holds the schemas, the types and the check API.
- `@yokla/core/testing` holds helpers for testing checks and packs.

Most people run the `yokla` command instead. The guide in the yokla repository
(`docs/guide/`) documents it.

## License

Apache-2.0
