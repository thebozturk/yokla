// Runs the yokla project in the current directory through the library API,
// writes its results and a JUnit report, and exits with the gate's code, as
// yokla run and yokla gate would. Run it with `node run-and-gate.ts` where
// yokla.profile.yaml is.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  ConfigError,
  gate,
  junitReport,
  loadProject,
  LoadError,
  readBaseline,
  ResultsError,
  run,
  terminalReport,
} from 'yokla';

const EXIT_CODES = { pass: 0, broken: 1, unjudgeable: 2 } as const;

try {
  const project = await loadProject();
  const { results } = await run(project);

  mkdirSync('runs', { recursive: true });
  const path = `runs/${results.run.id}.json`;
  writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync('runs/junit.xml', junitReport(results));
  const summary = terminalReport(results);
  for (const line of summary.out) console.log(line);
  for (const line of summary.err) console.error(line);
  console.log(`results: ${path}`);

  const baseline = existsSync('yokla.baseline.json')
    ? readBaseline('yokla.baseline.json')
    : undefined;
  const outcome = gate(results, { config: project.config, baseline });
  console.log(`gate: ${outcome.verdict}`);
  for (const breach of outcome.breaches) console.log(`  ${breach.message}`);
  for (const problem of outcome.problems) console.error(`  ${problem}`);
  process.exitCode = EXIT_CODES[outcome.verdict];
} catch (error) {
  if (error instanceof LoadError || error instanceof ResultsError || error instanceof ConfigError) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
