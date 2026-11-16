// The proposal (ADR-0047): a profile with a provenance map at its top, each
// machine-made entry `proposed`, and the person's own inputs as given. The
// same inputs give the same file.

import {
  ANALYSIS_SCHEMA_ID,
  compareProfiles,
  pointerPath,
  toJson,
  type Analysis,
  type DataEntry,
  type JsonValue,
  type Provenance,
} from '@yokla/core';
import { parse, stringify } from 'yaml';
import type { Inventory } from './inventory.ts';
import type { FoundCollection, Probed } from './probe.ts';

export interface ProposedEntry {
  readonly pointer: string;
  readonly value: JsonValue;
  readonly provenance: Provenance;
}

/** What the person gave, written as given: never compared, never proposed. */
export interface PersonInputs {
  readonly name: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: JsonValue;
  /** The languages the person named, if any. */
  readonly languages: readonly string[];
}

/** The pointers of the person's inputs, left out of a comparison. */
export function personPointers(person: PersonInputs): string[] {
  return [
    '/target/name',
    '/target/adapter',
    '/target/request',
    ...(person.languages.length > 0 ? ['/languages'] : []),
  ];
}

const proposed = (source: Provenance['source'], evidence: string): Provenance =>
  source === 'human' ? { source, status: 'approved' } : { source, evidence, status: 'proposed' };

function collectionEntries(
  found: FoundCollection,
  evidenceFields: Readonly<Record<string, string>>,
): ProposedEntry[] {
  const base = `/target/response/evidence/${found.name}`;
  const { match } = found;
  const at = `probe ${String(found.probe)}`;
  const entries: ProposedEntry[] = [
    {
      pointer: `${base}/items`,
      value: match.items,
      provenance: proposed(
        'probe',
        `${at}: ${match.items} holds ${String(match.matched)} catalog row(s), by id`,
      ),
    },
  ];
  const named = new Set<string>();
  for (const [column, path] of Object.entries(match.fields)) {
    const field = evidenceFields[column];
    if (field === undefined || named.has(field)) continue;
    named.add(field);
    entries.push({
      pointer: `${base}/fields/${field}`,
      value: path,
      provenance: proposed(
        'probe',
        `${at}: ${path} equals the catalog's ${column} in ${String(match.matched)} of ${String(match.matched)} items`,
      ),
    });
  }
  return entries;
}

/** What the greeting's answer, probe 1, showed. */
function from(rule: string): Provenance {
  return proposed('probe', `probe 1: ${rule}`);
}

/** The entries the probes give: the response's text, route and stream, what it carries, and the evidence. */
export function probeEntries(
  probed: Probed,
  evidenceFields: Readonly<Record<string, string>>,
): ProposedEntry[] {
  const { inference } = probed;
  const entries: ProposedEntry[] = [];
  const response = inference.response;
  if (response.stream !== undefined) {
    entries.push({
      pointer: '/target/response/stream',
      value: toJson(response.stream),
      provenance: from('the answer is an event stream'),
    });
  }
  entries.push({
    pointer: '/target/response/text',
    value: inference.text.path,
    provenance: from(`${inference.text.path}, ${inference.text.rule}`),
  });
  if (inference.route !== undefined) {
    entries.push({
      pointer: '/target/response/route',
      value: inference.route.path,
      provenance: from(`${inference.route.path}, ${inference.route.rule}`),
    });
  }
  if (inference.carry.length > 0) {
    entries.push({
      pointer: '/target/session/carry',
      value: inference.carry.map((entry) => ({ name: entry.name, from: entry.from })),
      provenance: from(`carried ${inference.carry.map((entry) => entry.from).join(', ')}`),
    });
  }
  if (probed.sessionOpen !== undefined) {
    entries.push({
      pointer: '/target/session/open',
      value: {
        request: { url: probed.sessionOpen.url, body: {} },
        carry: [{ name: 'session', from: probed.sessionOpen.from }],
      },
      provenance: from(`the session url answered with an id at ${probed.sessionOpen.from}`),
    });
  }
  for (const found of probed.collections) entries.push(...collectionEntries(found, evidenceFields));
  return entries;
}

/** The data entries, with their provenance. */
export function dataEntries(entries: readonly DataEntry[]): ProposedEntry[] {
  return entries.map((entry) => ({
    pointer: entry.pointer,
    value: entry.value,
    provenance: proposed('data', entry.evidence),
  }));
}

function setAt(document: Record<string, JsonValue>, pointer: string, value: JsonValue): void {
  const path = pointerPath(pointer);
  let at: Record<string, JsonValue> = document;
  for (const key of path.slice(0, -1)) {
    const next = at[key];
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) at = next;
    else {
      const created: Record<string, JsonValue> = {};
      at[key] = created;
      at = created;
    }
  }
  const last = path.at(-1);
  if (last !== undefined) at[last] = value;
}

/**
 * The proposed profile: the person's request, and every entry at its pointer,
 * with a provenance map at the top for the machine-made ones.
 */
export function proposalDocument(
  person: PersonInputs,
  sessionModeValue: 'client' | 'none',
  entries: readonly ProposedEntry[],
): Record<string, JsonValue> {
  const document: Record<string, JsonValue> = {
    version: 1,
    target: {
      name: person.name,
      adapter: 'http',
      request: {
        url: person.url,
        method: 'POST',
        ...(Object.keys(person.headers).length === 0 ? {} : { headers: { ...person.headers } }),
        body: person.body,
      },
      response: {},
      session: { mode: sessionModeValue },
    },
    ...(person.languages.length > 0 ? { languages: [...person.languages] } : {}),
  };
  for (const entry of entries) setAt(document, entry.pointer, entry.value);
  const provenance: Record<string, JsonValue> = {};
  for (const entry of entries) provenance[entry.pointer] = toJson(entry.provenance);
  return { provenance, ...document };
}

const HEADER = (
  version: string,
) => `Proposed by yokla analyze ${version} (ADR-0047). Nothing here runs until a person
approves it. To approve an entry, set its status in provenance to approved, or
delete its line there to make the entry yours. To reject one, delete the entry
and its line. Then keep the file as yokla.profile.yaml. docs/guide/profile.md
describes each field; \`yokla schema profile\` prints the JSON Schema.`;

/** The proposal as YAML, with the header that says how to approve it. */
export function proposalYaml(document: Record<string, JsonValue>, version: string): string {
  const body = stringify(document, { lineWidth: 0 });
  const header = HEADER(version)
    .split('\n')
    .map((line) => `# ${line}`)
    .join('\n');
  return `${header}\n\n${body}`;
}

/** The analysis report: what was inventoried, probed and proposed, and the comparison. */
export function analysisReport(input: {
  readonly version: string;
  readonly inventory: Inventory;
  readonly probes: Probed['probes'];
  readonly entries: readonly ProposedEntry[];
  readonly proposal: JsonValue;
  readonly reference?: { readonly path: string; readonly document: JsonValue };
  readonly exclude: readonly string[];
}): Analysis {
  const comparison =
    input.reference === undefined
      ? undefined
      : compareProfiles(input.proposal, input.reference.document, input.exclude);
  return {
    schema: ANALYSIS_SCHEMA_ID,
    yokla: { version: input.version },
    inventory: {
      files: input.inventory.files.map((file) => ({ ...file })),
      skipped: input.inventory.skipped,
      capped: input.inventory.capped,
    },
    probes: input.probes.map((probe) => ({ ...probe })),
    entries: input.entries.map((entry) => ({ ...entry })),
    ...(comparison === undefined || input.reference === undefined
      ? {}
      : {
          comparison: {
            profile: input.reference.path,
            same: [...comparison.same],
            different: [...comparison.different],
            new: [...comparison.new],
            missed: [...comparison.missed],
            precision: comparison.precision,
            recall: comparison.recall,
          },
        }),
  };
}

/** A profile's text as a document: its entries as written, without the schema's defaults. */
export function profileDocument(text: string): JsonValue {
  return toJson(parse(text));
}
