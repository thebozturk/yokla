// The yokla package's exports: its library API (ADR-0093). Only these are
// promised; the @yokla/* packages are yokla's parts and may change in any
// release. index.test.ts lists every name, so a change shows in review.

export {
  caseRows,
  compare,
  comparisonHtml,
  comparisonReport,
  createAssertion,
  gate,
  htmlReport,
  junitReport,
  loadProject,
  markdownReport,
  projectFrom,
  resultRows,
  run,
  terminalReport,
  type AssertionAnswer,
  type AssertionContext,
  type AssertionOptions,
  type AssertionResult,
  type GateOptions,
  type LoadProjectOptions,
  type ProjectFromOptions,
  type RunOptions,
  type RunOutcome,
} from './api.ts';
export type { Output } from './commands/run.ts';
export { LoadError, loadConfig, readBaseline, readResults, ResultsError } from './load.ts';
export { main } from './main.ts';
export { readCassette, type Project, type ReadCassette } from './prepare.ts';
export { jsonSchemas, schemas } from './schemas.ts';
export { version } from './version.ts';
export type {
  AttackerRun,
  Baseline,
  Case,
  Cassette,
  Comparison,
  GateBreach,
  GateOutcome,
  ModelSwap,
  Profile,
  Results,
  Strategy,
  ToolReversal,
  TransformKind,
  YoklaConfig,
} from '@yokla/core';
export type { CaseRow, ResultRow, TurnVerdict } from '@yokla/interop-rows';
export type { TerminalSummary } from '@yokla/report';
export { ConfigError, type GivenAnswer, type RewritePlan } from '@yokla/runtime';
