// yokla's analyzer (design §8, ADR-0047), deterministic first: the
// repository's inventory, the entries its data gives through the domain
// pack, and the response mapping a few probes give. It makes no model call.

import { relative, sep } from 'node:path';
import type { DataFile, DomainPack, JsonValue, LanguagePack } from '@yokla/core';
import { readDataFiles } from './data.ts';
import { inventory, type Inventory } from './inventory.ts';
import { plannedMessages, probeTarget, type ProbeTarget, type SentProbe } from './probe.ts';
import {
  dataEntries,
  personPointers,
  probeEntries,
  proposalDocument,
  type PersonInputs,
  type ProposedEntry,
} from './propose.ts';
import { sessionMode } from '@yokla/core';

export { inventory, MAX_FILE_BYTES, type Inventory, type InventoryFile } from './inventory.ts';
export { MAX_ROWS, readDataFiles, rowsOf } from './data.ts';
export { ProbeError, type Probed, type ProbeTarget, type SentProbe } from './probe.ts';
export {
  analysisReport,
  personPointers,
  profileDocument,
  proposalYaml,
  type PersonInputs,
  type ProposedEntry,
} from './propose.ts';

export interface AnalyzeOptions {
  /** The target's repository. */
  readonly dir: string;
  /** The folder the proposal is written to: data paths are relative to it. */
  readonly outDir: string;
  readonly person: PersonInputs;
  readonly probe: Omit<ProbeTarget, 'url' | 'headers' | 'body' | 'greeting'>;
  /** The greeting per language; the probes go in the profile's first language. */
  readonly greetings: Readonly<Record<string, string>>;
  readonly maxFiles: number;
  readonly domainPacks: readonly DomainPack[];
  readonly languages: readonly LanguagePack[];
  /** Hears what is about to happen: the inventory, then the messages before they are sent. */
  readonly onInventory?: (listed: Inventory) => void;
  readonly onProbes?: (messages: readonly string[]) => void;
}

export interface Analyzed {
  readonly inventory: Inventory;
  readonly probes: readonly SentProbe[];
  readonly entries: readonly ProposedEntry[];
  readonly document: Record<string, JsonValue>;
  /** The pointers a comparison leaves out: the person's own inputs. */
  readonly exclude: readonly string[];
}

/** A data file's path as the proposed profile reads it: relative to its folder. */
function pathFrom(outDir: string, dir: string): (inRepo: string) => string {
  return (inRepo) => {
    const path = relative(outDir, `${dir}${sep}${inRepo.split('/').join(sep)}`)
      .split(sep)
      .join('/');
    return path.startsWith('.') ? path : `./${path}`;
  };
}

/** Inventories, reads the data, probes the target, and puts the proposal together. */
export async function analyzeTarget(options: AnalyzeOptions): Promise<Analyzed> {
  const listed = inventory(options.dir, options.maxFiles);
  options.onInventory?.(listed);
  const files: DataFile[] = readDataFiles(
    options.dir,
    listed.files,
    pathFrom(options.outDir, options.dir),
  );
  const { person } = options;
  const entries: ProposedEntry[] = [];
  let probedRows;
  let evidenceFields: Readonly<Record<string, string>> = {};
  for (const pack of options.domainPacks) {
    const analysis = pack.analyzer?.analyze(files, {
      languages: options.languages,
      given: person.languages,
    });
    if (analysis === undefined) continue;
    entries.push(...dataEntries(analysis.entries));
    if (analysis.probed !== undefined && probedRows === undefined) {
      probedRows = analysis.probed;
      evidenceFields = analysis.probed.evidenceFields;
    }
  }
  // A profile names its languages: the person's, the data's, or else English.
  const languageEntry = entries.find((entry) => entry.pointer === '/languages');
  const found = Array.isArray(languageEntry?.value)
    ? languageEntry.value.filter((code): code is string => typeof code === 'string')
    : [];
  if (person.languages.length === 0 && found.length === 0) {
    entries.push({
      pointer: '/languages',
      value: ['en'],
      provenance: {
        source: 'template',
        evidence: 'no language was given, and no data file names one; en is the default',
        status: 'proposed',
      },
    });
  }
  const first = person.languages[0] ?? found[0] ?? 'en';
  // A profile names its domain; with no pack's data found, the only pack is a guess.
  const [onlyPack] = options.domainPacks;
  if (!entries.some((entry) => entry.pointer === '/domain') && onlyPack !== undefined) {
    entries.push({
      pointer: '/domain',
      value: onlyPack.id,
      provenance: {
        source: 'template',
        evidence: `no pack found its data; ${onlyPack.id} is the domain pack yokla has`,
        status: 'proposed',
      },
    });
  }
  const target: ProbeTarget = {
    ...options.probe,
    greeting: options.greetings[first] ?? options.greetings['en'] ?? 'Hello!',
    url: person.url,
    headers: person.headers,
    body: person.body,
  };
  options.onProbes?.(plannedMessages(target, probedRows));
  const probed = await probeTarget(target, probedRows);
  entries.unshift(...probeEntries(probed, evidenceFields));
  const mode = sessionMode({ url: person.url, headers: person.headers, body: person.body });
  return {
    inventory: listed,
    probes: probed.probes,
    entries,
    document: proposalDocument(person, mode, entries),
    exclude: personPointers(person),
  };
}
