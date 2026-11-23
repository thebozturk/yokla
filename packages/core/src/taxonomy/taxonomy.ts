// Findings mapped to frameworks (ADR-0089): the frameworks yokla maps to,
// each at the version mapped, the categories it uses of each, and the
// mapping of core's attack kinds and checks. A domain pack maps its own. The
// mapping is yokla's judgement, made for this tool: never a claim of
// compliance. Core is pure.

import type { Results, RunTaxonomy } from '../schema/results.ts';

/** How bad a success of an attack is, from the mapping. */
export const KIND_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type KindSeverity = (typeof KIND_SEVERITIES)[number];

export interface Framework {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** The categories yokla maps to, by code; a category's id is `<framework>:<code>`. */
  readonly categories: readonly { readonly code: string; readonly name: string }[];
}

/** The frameworks, as their own publications name them (ADR-0089). */
export const FRAMEWORKS: readonly Framework[] = [
  {
    id: 'owasp-llm',
    name: 'OWASP Top 10 for LLM Applications',
    version: '2025',
    categories: [
      { code: 'LLM01', name: 'Prompt Injection' },
      { code: 'LLM02', name: 'Sensitive Information Disclosure' },
      { code: 'LLM04', name: 'Data and Model Poisoning' },
      { code: 'LLM05', name: 'Improper Output Handling' },
      { code: 'LLM06', name: 'Excessive Agency' },
      { code: 'LLM07', name: 'System Prompt Leakage' },
      { code: 'LLM09', name: 'Misinformation' },
      { code: 'LLM10', name: 'Unbounded Consumption' },
    ],
  },
  {
    id: 'owasp-agentic',
    name: 'OWASP Top 10 for Agentic Applications',
    version: '2026',
    categories: [
      { code: 'ASI01', name: 'Agent Goal Hijack' },
      { code: 'ASI02', name: 'Tool Misuse and Exploitation' },
      { code: 'ASI03', name: 'Identity and Privilege Abuse' },
      { code: 'ASI04', name: 'Agentic Supply Chain Vulnerabilities' },
      { code: 'ASI05', name: 'Unexpected Code Execution' },
      { code: 'ASI06', name: 'Memory and Context Poisoning' },
      { code: 'ASI09', name: 'Human-Agent Trust Exploitation' },
    ],
  },
  {
    id: 'mitre-atlas',
    name: 'MITRE ATLAS',
    version: '2026.07',
    categories: [
      { code: 'AML.TA0005', name: 'Execution' },
      { code: 'AML.TA0006', name: 'Persistence' },
      { code: 'AML.TA0008', name: 'Discovery' },
      { code: 'AML.TA0010', name: 'Exfiltration' },
      { code: 'AML.TA0011', name: 'Impact' },
      { code: 'AML.TA0012', name: 'Privilege Escalation' },
    ],
  },
  {
    id: 'nist-ai-rmf',
    name: 'NIST AI RMF',
    version: '1.0',
    categories: [
      { code: 'MEASURE 2.5', name: 'Valid and reliable' },
      { code: 'MEASURE 2.6', name: 'Safety' },
      { code: 'MEASURE 2.7', name: 'Security and resilience' },
      { code: 'MEASURE 2.10', name: 'Privacy' },
      { code: 'MEASURE 2.11', name: 'Fairness and bias' },
    ],
  },
  {
    id: 'iso-42001',
    name: 'ISO/IEC 42001',
    version: '2023',
    categories: [{ code: 'A.6.2.4', name: 'AI system verification and validation' }],
  },
  {
    id: 'gdpr',
    name: 'GDPR',
    version: 'Regulation (EU) 2016/679',
    categories: [{ code: 'Article 32', name: 'Security of processing' }],
  },
  {
    id: 'kvkk',
    name: 'KVKK',
    version: 'Law No. 6698',
    categories: [{ code: 'Article 12', name: 'Obligations on data security' }],
  },
  {
    id: 'eu-ai-act',
    name: 'EU AI Act',
    version: 'Regulation (EU) 2024/1689',
    categories: [
      { code: 'Article 15', name: 'Accuracy, robustness and cybersecurity' },
      {
        code: 'Article 50',
        name: 'Transparency obligations for providers and deployers of certain AI systems',
      },
    ],
  },
];

/** The mapping of a pack's or core's attack kinds and checks to category ids. */
export interface Taxonomy {
  readonly kinds: Readonly<
    Record<string, { readonly severity: KindSeverity; readonly categories: readonly string[] }>
  >;
  readonly checks: Readonly<Record<string, readonly string[]>>;
}

/** The category ids of the mapping, by their codes, so the tables below read as the ADR's. */
export const CATEGORY = {
  LLM01: 'owasp-llm:LLM01',
  LLM02: 'owasp-llm:LLM02',
  LLM04: 'owasp-llm:LLM04',
  LLM05: 'owasp-llm:LLM05',
  LLM06: 'owasp-llm:LLM06',
  LLM07: 'owasp-llm:LLM07',
  LLM09: 'owasp-llm:LLM09',
  LLM10: 'owasp-llm:LLM10',
  ASI01: 'owasp-agentic:ASI01',
  ASI02: 'owasp-agentic:ASI02',
  ASI03: 'owasp-agentic:ASI03',
  ASI04: 'owasp-agentic:ASI04',
  ASI05: 'owasp-agentic:ASI05',
  ASI06: 'owasp-agentic:ASI06',
  ASI09: 'owasp-agentic:ASI09',
  execution: 'mitre-atlas:AML.TA0005',
  persistence: 'mitre-atlas:AML.TA0006',
  discovery: 'mitre-atlas:AML.TA0008',
  exfiltration: 'mitre-atlas:AML.TA0010',
  impact: 'mitre-atlas:AML.TA0011',
  privilegeEscalation: 'mitre-atlas:AML.TA0012',
  valid: 'nist-ai-rmf:MEASURE 2.5',
  safety: 'nist-ai-rmf:MEASURE 2.6',
  security: 'nist-ai-rmf:MEASURE 2.7',
  privacy: 'nist-ai-rmf:MEASURE 2.10',
  fairness: 'nist-ai-rmf:MEASURE 2.11',
  verification: 'iso-42001:A.6.2.4',
  gdpr: 'gdpr:Article 32',
  kvkk: 'kvkk:Article 12',
  aiAct: 'eu-ai-act:Article 15',
  transparency: 'eu-ai-act:Article 50',
} as const;

const C = CATEGORY;

/** What every attack kind maps to: an attack case is a verification test (ISO/IEC 42001). */
const TESTED = [C.verification] as const;
/** What personal data leaking maps to in law. */
const PERSONAL_DATA = [C.gdpr, C.kvkk] as const;

/** Core's attack kinds and checks (ADR-0089). */
export const CORE_TAXONOMY: Taxonomy = {
  kinds: {
    injection: {
      severity: 'high',
      categories: [C.LLM01, C.ASI01, C.execution, C.security, ...TESTED, C.aiAct],
    },
    extraction: {
      severity: 'medium',
      categories: [C.LLM07, C.discovery, C.exfiltration, C.security, ...TESTED, C.aiAct],
    },
    internals: {
      severity: 'low',
      categories: [C.LLM07, C.discovery, C.security, ...TESTED, C.aiAct],
    },
    'cost-abuse': {
      severity: 'medium',
      categories: [C.LLM10, C.impact, C.security, ...TESTED, C.aiAct],
    },
    'cross-session': {
      severity: 'critical',
      categories: [C.LLM02, C.exfiltration, C.privacy, ...TESTED, ...PERSONAL_DATA],
    },
    'memory-poisoning': {
      severity: 'high',
      categories: [C.LLM01, C.LLM04, C.ASI06, C.persistence, C.security, ...TESTED, C.aiAct],
    },
    pretext: {
      severity: 'critical',
      categories: [C.LLM02, C.exfiltration, C.privacy, ...TESTED, ...PERSONAL_DATA],
    },
    privilege: {
      severity: 'high',
      categories: [C.LLM06, C.ASI03, C.privilegeEscalation, C.security, ...TESTED, C.aiAct],
    },
    card: {
      severity: 'critical',
      categories: [C.LLM02, C.exfiltration, C.privacy, ...TESTED, ...PERSONAL_DATA],
    },
    // The judge decides these (ADR-0090, ADR-0091).
    'unsafe-advice': {
      severity: 'high',
      categories: [C.LLM09, C.impact, C.safety, ...TESTED, C.aiAct],
    },
    hijacking: { severity: 'medium', categories: [C.ASI01, C.impact, C.valid, ...TESTED, C.aiAct] },
    'unruled-restriction': {
      severity: 'high',
      categories: [C.LLM06, C.impact, C.safety, ...TESTED, C.aiAct],
    },
    bias: { severity: 'high', categories: [C.impact, C.fairness, ...TESTED] },
    'political-religious': { severity: 'medium', categories: [C.impact, C.fairness, ...TESTED] },
    'harmful-content': { severity: 'high', categories: [C.impact, C.safety, ...TESTED] },
    imitation: {
      severity: 'high',
      categories: [C.LLM09, C.ASI09, C.impact, C.valid, ...TESTED, C.transparency],
    },
    'unverifiable-claim': {
      severity: 'medium',
      categories: [C.LLM09, C.impact, C.valid, ...TESTED, C.aiAct],
    },
  },
  checks: {
    'injection-canary': [C.LLM01, C.ASI01],
    'untrusted-in-system': [C.LLM01, C.ASI01],
    'prompt-leak': [C.LLM07],
    'internals-leak': [C.LLM07],
    'pii-leak': [C.LLM02, C.privacy, ...PERSONAL_DATA],
    'pii-in-prompt': [C.LLM02, C.privacy, ...PERSONAL_DATA],
    'card-number': [C.LLM02, C.privacy, ...PERSONAL_DATA],
    'tool-argument-marker': [C.LLM05, C.ASI02],
    'tool-calls': [C.LLM06, C.ASI02],
    'prompt-budget': [C.LLM10],
    'cost-budget': [C.LLM10],
  },
};

/** Taxonomies merged; a kind or check two of them map is an error. */
export function mergeTaxonomies(...taxonomies: readonly Taxonomy[]): Taxonomy {
  const kinds: Record<string, Taxonomy['kinds'][string]> = {};
  const checks: Record<string, readonly string[]> = {};
  for (const taxonomy of taxonomies) {
    for (const [kind, mapping] of Object.entries(taxonomy.kinds)) {
      if (kind in kinds) throw new Error(`attack kind "${kind}" is mapped twice`);
      kinds[kind] = mapping;
    }
    for (const [check, categories] of Object.entries(taxonomy.checks)) {
      if (check in checks) throw new Error(`check "${check}" is mapped twice`);
      checks[check] = categories;
    }
  }
  return { kinds, checks };
}

/** A redteam case's attack kinds: its tags that name a kind the mapping knows (ADR-0089). */
export function caseKinds(
  testCase: { readonly suite: string; readonly tags?: readonly string[] | undefined },
  taxonomy: Taxonomy,
): string[] {
  if (testCase.suite !== 'redteam') return [];
  return (testCase.tags ?? []).filter((tag) => Object.hasOwn(taxonomy.kinds, tag));
}

/** The categories a failing finding names: its case's kinds' and its check's (ADR-0089). */
export function findingCategories(
  kinds: readonly string[],
  check: string,
  taxonomy: Pick<Taxonomy, 'kinds' | 'checks'>,
): string[] {
  const named = [
    ...kinds.flatMap((kind) => taxonomy.kinds[kind]?.categories ?? []),
    ...(taxonomy.checks[check] ?? []),
  ];
  return [...new Set(named)];
}

/**
 * What results.v1 keeps of the mapping (ADR-0089): the kinds the cases have,
 * the mapped checks that judged a turn, and the frameworks and categories
 * they name. Undefined when they name none.
 */
export function runTaxonomy(taxonomy: Taxonomy, cases: Results['cases']): RunTaxonomy | undefined {
  const kinds: RunTaxonomy['kinds'] = {};
  for (const kind of [...new Set(cases.flatMap((c) => c.kinds ?? []))].toSorted()) {
    const mapping = taxonomy.kinds[kind];
    if (mapping !== undefined) {
      kinds[kind] = { severity: mapping.severity, categories: [...mapping.categories] };
    }
  }
  const applied = new Set(
    cases.flatMap((c) =>
      c.samples.flatMap((sample) =>
        sample.turns.flatMap((turn) =>
          turn.checks.filter((check) => check.applicable).map((check) => check.check),
        ),
      ),
    ),
  );
  const checks: RunTaxonomy['checks'] = {};
  for (const check of [...applied].toSorted()) {
    const categories = taxonomy.checks[check];
    if (categories !== undefined) checks[check] = [...categories];
  }
  const named = new Set([
    ...Object.values(kinds).flatMap((mapping) => mapping.categories),
    ...Object.values(checks).flat(),
  ]);
  const frameworks = FRAMEWORKS.flatMap((framework) => {
    const categories = framework.categories
      .map((category) => ({ id: `${framework.id}:${category.code}`, name: category.name }))
      .filter((category) => named.has(category.id));
    return categories.length === 0
      ? []
      : [{ id: framework.id, name: framework.name, version: framework.version, categories }];
  });
  return frameworks.length === 0 ? undefined : { frameworks, kinds, checks };
}

/**
 * Each category a failing finding of the results names, with the cases
 * that failed it, in the order of the frameworks and their categories
 * (ADR-0089).
 */
export function failingCategories(
  results: Pick<Results, 'cases' | 'taxonomy'>,
): { readonly category: string; readonly cases: readonly string[] }[] {
  const { taxonomy } = results;
  if (taxonomy === undefined) return [];
  const failing = new Map<string, Set<string>>();
  for (const c of results.cases) {
    for (const sample of c.samples) {
      for (const turn of sample.turns) {
        for (const check of turn.checks) {
          if (!check.findings.some((finding) => finding.verdict === 'fail')) continue;
          for (const category of findingCategories(c.kinds ?? [], check.check, taxonomy)) {
            failing.set(category, (failing.get(category) ?? new Set()).add(c.id));
          }
        }
      }
    }
  }
  return taxonomy.frameworks.flatMap((framework) =>
    framework.categories.flatMap((category) => {
      const cases = failing.get(category.id);
      return cases === undefined ? [] : [{ category: category.id, cases: [...cases] }];
    }),
  );
}
