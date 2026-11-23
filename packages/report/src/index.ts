// Public API of @yokla/report: reports rendered from results.v1 alone.

export { CONTENT_SECURITY_POLICY, htmlReport } from './html.ts';
export { junitXml, xmlAttribute, xmlText } from './junit.ts';
export { comparisonText } from './compare.ts';
export { caseProblems, caseReason, type CaseProblems, type Problem } from './problems.ts';
export { markdownReport, MARKDOWN_ROWS } from './markdown.ts';
export { terminalSummary, type TerminalSummary } from './terminal.ts';
export { originText, withOrigin } from './format.ts';
