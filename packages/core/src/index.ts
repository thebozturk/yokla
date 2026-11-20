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
export { childPath } from './extract/member.ts';
export {
  MASK,
  maskDeep,
  maskSecrets,
  oauthError,
  readToken,
  refreshMargin,
  type Token,
} from './auth/token.ts';
export {
  getFieldPath,
  parseJsonPath,
  queryJsonPath,
  selectJsonPath,
  updateJsonPath,
  type Segment,
} from './extract/jsonpath.ts';
export {
  compileSchema,
  schemaProblems,
  validateCompiled,
  validateJson,
  type CompiledSchema,
  type JsonSchema,
  type Violation,
} from './jsonschema/jsonschema.ts';
export {
  eventName,
  messageEvents,
  parseStream,
  readEvents,
  readStream,
  type EventSpec,
  type ReadStream,
  type StreamChunk,
  type StreamEvent,
} from './extract/stream.ts';
export {
  readToolResult,
  seenEvidence,
  type Seen,
  type ToolResultsMapping,
} from './extract/seen.ts';
export {
  extractEvidence,
  extractField,
  extractResponse,
  toJson,
  type EvidenceItem,
  type ExtractedResponse,
  type JsonValue,
} from './extract/response.ts';
export {
  buildMessage,
  buildRequest,
  checkTemplates,
  mergeJson,
  renderText,
  TemplateError,
  type BuiltRequest,
  type RequestTemplate,
  type TemplateCheck,
  type TemplateValues,
} from './request/build.ts';
export { buildSchemas, type DomainPackSchemas, type SchemaOptions } from './schema/build.ts';
export {
  coreExpectations,
  KnownGap,
  type Case,
  type CaseFile,
  type CaseCustomer,
  type CaseTurn,
} from './schema/cases.ts';
export {
  FieldName,
  FieldPath,
  Id,
  ID_PATTERN,
  JSON_PATH_PATTERN,
  JsonPath,
  JsonSchemaValue,
  LanguageCode,
  MACHINE_SOURCES,
  compilePattern,
  Pattern,
  type PatternSpec,
  SchemaRule,
  showPattern,
  Provenance,
  ReviewStatus,
  reviewStatus,
  Suite,
  SUITES,
  TRANSFORM_KINDS,
  TransformKind,
  MODEL_TRANSFORMS,
  type ModelTransform,
} from './schema/common.ts';
export {
  FieldSpec,
  type ModelProxyConfig,
  type HttpProfileTarget,
  type MessageStream,
  type Profile,
  type ProfileTarget,
  type TargetAuth,
  type WebSocketProfileTarget,
  isSafeCredentialUrl,
} from './schema/profile.ts';
export { Cassette, CASSETTE_SCHEMA_ID } from './schema/cassette.ts';
export {
  CassetteCall,
  ModelSwap,
  ToolInjection,
  ToolResultChange,
  ToolReversal,
  ModelOutput,
  PromptMessage,
  PromptRole,
  PromptStore,
  ProxyRecord,
  ProxyUsage,
  SpanCall,
  ToolCall,
} from './schema/proxy.ts';
export { Fault, FAULT_KINDS, FaultPlan } from './schema/fault.ts';
export { callCost } from './proxy/cost.ts';
export {
  redact,
  REDACTED,
  storeOutput,
  storePrompt,
  storeToolCalls,
  type PromptStorage,
} from './proxy/prompts.ts';
export { plan, type Plan, type PlannedCase } from './plan/plan.ts';
export { GateConfig, YoklaConfig, type OwnModel, type Price } from './schema/config.ts';
export { evaluateGate, type GateBreach, type GateOutcome } from './gate/gate.ts';
export { Comparison, COMPARISON_SCHEMA_ID, compareRuns, runLabel } from './compare/compare.ts';
export {
  argumentShape,
  Coverage,
  EMPTY_COVERAGE,
  newCoverage,
  RunCoverage,
  unionCoverage,
} from './explore/coverage.ts';
export {
  DEFAULT_EXPLORE_TYPES,
  explore,
  exploreFaults,
  type ExploreCandidate,
  type Explored,
  type ExploreOptions,
  type ExploreOutcome,
  type ExploreResult,
  type ExploreTrial,
  type KeptCandidate,
  type ObservedTurn,
} from './explore/search.ts';
export { explorationEvidence, exploredCaseYaml } from './explore/write.ts';
export { Exploration, TracedCandidate } from './explore/trace.ts';
export { Baseline, BASELINE_SCHEMA_ID } from './schema/baseline.ts';
export { baselineChanges, baselineOf } from './baseline/baseline.ts';
export { caseDefinition, stableJson } from './baseline/definition.ts';
export {
  inferResponse,
  inferSessionId,
  shapeOf,
  type Candidate,
  type Inference,
  type InferOutcome,
  type Probe,
} from './init/infer.ts';
export {
  deadlineFromProbe,
  LONG_MESSAGE_CHARS,
  longMessage,
  starterCases,
  TEST_CARD,
  type StarterLanguage,
  type StarterOptions,
} from './init/starter.ts';
export {
  casesYaml,
  gitignoreAdditions,
  profileYaml,
  sessionMode,
  type ProfileInput,
} from './init/write.ts';
export {
  CASE_STATUSES,
  CaseResult,
  CaseStatus,
  CheckResult,
  CheckSummary,
  DimensionResult,
  Finding,
  FindingOrigin,
  FindingSubject,
  ORIGIN_STAGES,
  Results,
  RESULTS_SCHEMA_ID,
  Sample,
  Severity,
  TurnResult,
} from './schema/results.ts';

export {
  aggregateCase,
  settledFailure,
  summariseChecks,
  wilson,
  type CaseAggregate,
} from './checks/aggregate.ts';
export { runChecks } from './checks/run.ts';
export { findOrigin } from './checks/origin.ts';
export {
  applyCandidate,
  pickTarget,
  reproduction,
  sampleFails,
  shrink,
  shrunkCaseYaml,
  stillFails,
  wordsOf,
  type Reproduction,
  type ShrinkCandidate,
  type Shrunk,
  type ShrinkTarget,
  type Trial,
} from './shrink/shrink.ts';
export type {
  UnmeasuredDimension,
  AggregationPolicy,
  Check,
  CheckContext,
  CheckFinding,
  CheckOutcome,
  DomainPack,
  DurationMention,
  ExploredTurn,
  FindingSeverity,
  Intents,
  IntentTurn,
  LanguagePack,
  MoneyMention,
  PackIo,
  PhraseKind,
  PreparedPack,
  ProxyCallView,
  SeenItem,
  TurnView,
  UnmetFacts,
  GenerateOptions,
  Generated,
  GeneratedCase,
} from './checks/types.ts';
export { generatedCaseYaml, generatedId } from './generate/write.ts';
export {
  checkRewrite,
  transformPrompt,
  TRANSFORM_MARK,
  TRANSFORM_PROMPT_VERSION,
  type CheckedRewrite,
  type RewriteAsk,
  type SwitchedLanguages,
} from './transform/model.ts';
export {
  contractAt,
  contractKind,
  namesJsonSchemaDialect,
  readJsonSchema,
  readOpenApi,
  type ContractRead,
  type ContractRequest,
} from './analyze/contract.ts';
export { caseUnmetFacts } from './fixture/facts.ts';
export { findPhrases, hasPhrase, type PhraseMatch } from './text/phrases.ts';
export { findQuantities, type QuantityMention } from './text/quantities.ts';
export {
  keptTexts,
  quotedValues,
  transformMessage,
  type TransformContext,
  type TransformedMessage,
} from './text/transform.ts';
export { seededFraction, seededIndex } from './seed.ts';
export {
  compareProfiles,
  pointerOf,
  pointerPath,
  profileEntries,
  resolvePointer,
  unapprovedEntries,
  type ProfileComparison,
  type ProfileEntry,
} from './profile/entries.ts';
export { matchRows, type KnownRows, type MatchedCollection } from './analyze/match.ts';
export {
  ANALYZER_MARK,
  ANALYZER_PROMPT_VERSION,
  analyzerPrompt,
  chunkFiles,
  estimateExtraction,
  estimateTokens,
  EXTRACT_FIELDS,
  extractSource,
  isTestPath,
  markedFields,
  mergeExtracted,
  READ_KINDS,
  rankFiles,
  readableFiles,
  readReply,
  verifyEntry,
  type Chunk,
  type ChunkPart,
  type ExtractedEntry,
  type ExtractField,
  type ExtractionEstimate,
  type MarkedField,
  type ReturnedEntry,
  type SourceFile,
  type UnverifiedEntry,
  type VerifiedEntry,
} from './analyze/extract.ts';
export type {
  DataAnalysis,
  DataAnalyzer,
  DataEntry,
  DataFile,
  DataRow,
  ProbedRows,
  ProbeIntent,
} from './analyze/pack.ts';
export { Analysis, ANALYSIS_SCHEMA_ID, INVENTORY_KINDS, InventoryKind } from './schema/analysis.ts';
export {
  answerText,
  answeredStatus,
  answeredWithinDeadline,
  costBudget,
  UNANSWERED_JUDGES,
  gracefulUnderFault,
  evidenceCount,
  languageMatch,
  routeExpected,
  statusAllowed,
} from './checks/generic.ts';
export { piiInPrompt, promptBudget, promptLeak, untrustedInSystem } from './checks/inspection.ts';
export { toolCalls, toolCallValid } from './checks/tools.ts';
export { jsonSchemaCheck, MAX_VIOLATIONS } from './checks/schema.ts';
export { answerSimilarity } from './checks/similarity.ts';
export {
  customProblems,
  USER_CHECK_API,
  userCheck,
  UserCheckDefinition,
  userPolicies,
  type UserTurn,
} from './checks/user.ts';
export { textSimilarity } from './text/similarity.ts';
export { CORE_CHECKS, CORE_DIMENSIONS } from './checks/all.ts';
export { modelCallOf } from './otel/genai.ts';
export { readOtlpJson, readOtlpProtobuf, type AttributeValue, type OtlpSpan } from './otel/otlp.ts';
export {
  CUSTOMER_LANGUAGES,
  CUSTOMER_PROMPT_MARK,
  customerCacheKey,
  customerPrompt,
  goalReached,
  goalReachedCheck,
  type CustomerPrompt,
  type Exchanged,
} from './customer/customer.ts';
