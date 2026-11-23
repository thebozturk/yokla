# @yokla/interop-rows

[yokla](https://www.npmjs.com/package/yokla)'s cases and results as neutral
rows, for other tools: a JSON Lines row per case, `yokla.case-row/v1`, and a
row per turn of each sample of a run, `yokla.result-row/v1`. Each format has
a JSON Schema, and the guide lists what each leaves out.

It depends only on `@yokla/core`. Most people run `yokla export` and
`yokla report --rows` instead. The guide in the yokla repository
(`docs/guide/`) documents it.

## License

Apache-2.0
