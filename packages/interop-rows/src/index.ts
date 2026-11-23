// Public API of @yokla/interop-rows (ADR-0096): yokla's cases and results as
// neutral rows, for other tools; E5 reads rows back.

export { CASE_ROW_SCHEMA_ID, CaseRow, caseRows, type CaseRows } from './cases.ts';
export {
  RESULT_ROW_SCHEMA_ID,
  ResultRow,
  resultRows,
  TurnVerdict,
  turnVerdict,
} from './results.ts';
