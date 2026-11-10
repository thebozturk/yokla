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
export { FieldSpec, type Profile, type ProfileTarget } from './schema/profile.ts';
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

/** What a language pack provides. Grows with the checks (design §17). */
export interface LanguagePack {
  readonly language: string;
}
