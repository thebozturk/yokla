import { describe, expect, it } from 'vitest';
import * as yokla from './index.ts';

// The library API is the yokla package's exports (ADR-0093). This list is the
// promise: a change to it is a change to the API, which needs an ADR. The
// types are exported from index.ts beside these names.

describe('the library API (ADR-0093)', () => {
  it('exports exactly these names', () => {
    expect(Object.keys(yokla).toSorted()).toEqual([
      'ConfigError',
      'LoadError',
      'ResultsError',
      'compare',
      'comparisonReport',
      'gate',
      'htmlReport',
      'jsonSchemas',
      'junitReport',
      'loadConfig',
      'loadProject',
      'main',
      'markdownReport',
      'projectFrom',
      'readBaseline',
      'readCassette',
      'readResults',
      'run',
      'schemas',
      'terminalReport',
      'version',
    ]);
  });
});
