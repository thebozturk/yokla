// Packs build their schemas with this instance of Zod, so that every schema
// comes from the same copy.
export { z } from 'zod';

export {
  formatIssue,
  formatPath,
  parseConfig,
  type ConfigIssue,
  type ParseResult,
} from './config/parse.ts';
export { getFieldPath, parseJsonPath, queryJsonPath, type Segment } from './extract/jsonpath.ts';
export {
  extractField,
  extractResponse,
  toJson,
  type EvidenceItem,
  type ExtractedResponse,
  type JsonValue,
} from './extract/response.ts';
export {
  buildRequest,
  checkTemplates,
  mergeJson,
  TemplateError,
  type BuiltRequest,
  type TemplateCheck,
  type TemplateValues,
} from './request/build.ts';
export { buildSchemas, type DomainPackSchemas, type SchemaOptions } from './schema/build.ts';
export {
  coreExpectations,
  KnownGap,
  type Case,
  type CaseFile,
  type CaseTurn,
} from './schema/cases.ts';
export {
  FieldName,
  FieldPath,
  Id,
  ID_PATTERN,
  JSON_PATH_PATTERN,
  JsonPath,
  LanguageCode,
  MACHINE_SOURCES,
  Provenance,
  ReviewStatus,
  reviewStatus,
  Suite,
  SUITES,
} from './schema/common.ts';
export {
  FieldSpec,
  type ModelProxyConfig,
  type Profile,
  type ProfileTarget,
} from './schema/profile.ts';
export { PromptMessage, PromptRole, ProxyRecord, ProxyUsage } from './schema/proxy.ts';
export { Fault, FAULT_KINDS, FaultPlan } from './schema/fault.ts';
export { callCost } from './proxy/cost.ts';
export { plan, type Plan, type PlannedCase } from './plan/plan.ts';
export { GateConfig, YoklaConfig, type Price } from './schema/config.ts';
export { evaluateGate, type GateBreach, type GateOutcome } from './gate/gate.ts';
export { Baseline, BASELINE_SCHEMA_ID } from './schema/baseline.ts';
export { baselineChanges, baselineOf } from './baseline/baseline.ts';
export { caseDefinition, stableJson } from './baseline/definition.ts';
export {
  CASE_STATUSES,
  CaseResult,
  CaseStatus,
  CheckResult,
  CheckSummary,
  DimensionResult,
  Finding,
  Results,
  RESULTS_SCHEMA_ID,
  Sample,
  Severity,
  TurnResult,
} from './schema/results.ts';

export { aggregateCase, summariseChecks, wilson, type CaseAggregate } from './checks/aggregate.ts';
export { runChecks } from './checks/run.ts';
export type {
  UnmeasuredDimension,
  AggregationPolicy,
  Check,
  CheckContext,
  CheckFinding,
  CheckOutcome,
  DomainPack,
  DurationMention,
  FindingSeverity,
  LanguagePack,
  MoneyMention,
  PackIo,
  PhraseKind,
  PreparedPack,
  TurnView,
} from './checks/types.ts';
export { findPhrases, hasPhrase, type PhraseMatch } from './text/phrases.ts';
export {
  answerText,
  answeredWithinDeadline,
  CORE_CHECKS,
  costBudget,
  FAULT_JUDGES,
  gracefulUnderFault,
  evidenceCount,
  routeExpected,
} from './checks/generic.ts';
