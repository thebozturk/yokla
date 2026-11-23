// Public API of @yokla/interop-rows: yokla's cases and results as neutral rows,
// for other tools (ADR-0096), and another tool's rows read back as yokla's
// cases and results through the user's mapping (ADR-0097).

export { CASE_ROW_SCHEMA_ID, CaseRow, caseRows, type CaseRows } from './cases.ts';
export {
  RESULT_ROW_SCHEMA_ID,
  ResultRow,
  resultRows,
  TurnVerdict,
  turnVerdict,
} from './results.ts';
export {
  IMPORTED_CHECK,
  importCases,
  importedCaseYaml,
  importResults,
  idOf,
  VERDICT_DIMENSION,
  type ImportedCases,
  type ImportRun,
} from './import.ts';
export { IMPORT_MAPPING_SCHEMA_ID, ImportMapping, MappedValue, MappedVerdict } from './mapping.ts';
export { csvRecords, formatOf, readRows, ROW_FORMATS, RowsError, type RowFormat } from './read.ts';
