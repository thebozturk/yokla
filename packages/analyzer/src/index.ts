// yokla's analyzer (design §8, ADR-0047), deterministic first: the
// repository's inventory, the entries its data gives through the domain
// pack, and the response mapping a few probes give. It makes no model call.

import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type {
  DataFile,
  DomainPack,
  JsonValue,
  LanguagePack,
  OwnModel,
  ProbedRows,
} from '@yokla/core';
import { contractStep, type ContractReport } from './contract.ts';
import { readDataFiles, readGivenDataFiles } from './data.ts';
import { inventory, type Inventory } from './inventory.ts';
import {
  planModelStep,
  runModelStep,
  type ModelCaller,
  type ModelPlan,
  type ModelStep,
} from './model.ts';
import { plannedMessages, probeTarget, type ProbeTarget, type SentProbe } from './probe.ts';
import {
  dataEntries,
  personPointers,
  probeEntries,
  proposalDocument,
  undecidedFields,
  type PersonInputs,
  type ProposedEntry,
  type UndecidedField,
} from './propose.ts';
import { sessionMode } from '@yokla/core';

export { inventory, MAX_FILE_BYTES, type Inventory, type InventoryFile } from './inventory.ts';
export {
  isDataText,
  MAX_ROWS,
  readDataFiles,
  readGivenDataFiles,
  readRows,
  rowsOf,
  type ReadDataFile,
} from './data.ts';
export { ProbeError, type Probed, type ProbeTarget, type SentProbe } from './probe.ts';
export { contractStep, type ContractReport, type ContractStep } from './contract.ts';
export {
  planModelStep,
  runModelStep,
  UNREAD_CUT,
  UNREAD_NOT_JSON,
  type ModelCaller,
  type ModelPlan,
  type ModelStep,
  type UnreadChunk,
} from './model.ts';
export {
  analysisReport,
  MAX_CANDIDATES,
  personPointers,
  profileDocument,
  proposalYaml,
  readingOf,
  undecidedFields,
  undecidedLine,
  type PersonInputs,
  type ProposedEntry,
  type UndecidedField,
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
  /** Data files from outside the repository, as absolute paths (ADR-0065). */
  readonly data?: readonly string[];
  readonly domainPacks: readonly DomainPack[];
  readonly languages: readonly LanguagePack[];
  /** The model step (ADR-0049); without it, the analysis uses no model. */
  readonly model?: {
    readonly config: OwnModel;
    readonly caller: ModelCaller;
    readonly maxCostUsd: number;
    readonly chunkTokens: number;
    readonly maxTokens: number;
    readonly fresh: boolean;
    /** Where replies are cached. */
    readonly cacheDir: string;
  };
  /** Hears what is about to happen: the inventory, the messages, the model's plan. */
  readonly onInventory?: (listed: Inventory) => void;
  readonly onProbes?: (messages: readonly string[]) => void;
  /** Hears the data files read only to MAX_ROWS rows, before anything is sent (ADR-0066). */
  readonly onDataCut?: (paths: readonly string[]) => void;
  readonly onModelPlan?: (plan: ModelPlan) => void;
}

export interface Analyzed {
  readonly inventory: Inventory;
  readonly probes: readonly SentProbe[];
  readonly entries: readonly ProposedEntry[];
  /** Each contract file read, and what became of it (ADR-0057). */
  readonly contracts: readonly ContractReport[];
  /** The model step's outcome, when it ran (ADR-0049). */
  readonly model?: ModelStep;
  readonly document: Record<string, JsonValue>;
  /** The pointers a comparison leaves out: the person's own inputs. */
  readonly exclude: readonly string[];
  /** The data files read only to MAX_ROWS rows, by their path in the proposal (ADR-0066). */
  readonly cut: readonly string[];
  /** The evidence fields the probes' match fit two or more ways, none proposed (ADR-0068). */
  readonly undecided: readonly UndecidedField[];
}

/** The path a request url calls, for finding its operation in a contract. */
function requestPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
}

/** An absolute path as the proposed profile reads it: relative to its folder. */
function fromOut(outDir: string): (absolute: string) => string {
  return (absolute) => {
    const path = relative(outDir, absolute).split(sep).join('/');
    return path.startsWith('.') ? path : `./${path}`;
  };
}

/** A data file's path as the proposed profile reads it: relative to its folder. */
function pathFrom(outDir: string, dir: string): (inRepo: string) => string {
  return (inRepo) => fromOut(outDir)(`${dir}${sep}${inRepo.split('/').join(sep)}`);
}

interface Prepared {
  readonly listed: Inventory;
  readonly entries: ProposedEntry[];
  readonly probedRows: ProbedRows | undefined;
  readonly evidenceFields: Readonly<Record<string, string>>;
  /** The profile's languages: the person's, the data's, or else English. */
  readonly languages: readonly string[];
  /** The data files read only to MAX_ROWS rows (ADR-0066). */
  readonly cut: readonly string[];
}

/** The inventory, the data's entries, and the profile's languages: nothing sent yet. */
function prepare(options: AnalyzeOptions): Prepared {
  const listed = inventory(options.dir, options.maxFiles);
  options.onInventory?.(listed);
  const read = [
    ...readDataFiles(options.dir, listed.files, pathFrom(options.outDir, options.dir)),
    // Beside the repository's own data, the files given from outside it (ADR-0065).
    ...readGivenDataFiles(options.data ?? [], fromOut(options.outDir)),
  ];
  const files: DataFile[] = read.map(({ path, rows }) => ({ path, rows }));
  const cut = read.filter((file) => file.cut).map((file) => file.path);
  if (cut.length > 0) options.onDataCut?.(cut);
  const { person } = options;
  const entries: ProposedEntry[] = [];
  let probedRows: ProbedRows | undefined;
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
  const languages =
    person.languages.length > 0 ? person.languages : found.length > 0 ? found : ['en'];
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
  return { listed, entries, probedRows, evidenceFields, languages, cut };
}

/** The model's plan for the analysis: what it would read, and what that costs at most. */
function modelPlan(options: AnalyzeOptions, prepared: Prepared): ModelPlan | undefined {
  const { model } = options;
  return model === undefined
    ? undefined
    : planModelStep(
        options.dir,
        prepared.listed.files,
        model.config,
        prepared.languages,
        model.chunkTokens,
        model.maxTokens,
      );
}

/** What an analysis would read and cost, sending nothing: no probe, no model call (ADR-0049). */
export function planAnalysis(options: AnalyzeOptions): {
  readonly inventory: Inventory;
  readonly model: ModelPlan | undefined;
} {
  const prepared = prepare(options);
  return { inventory: prepared.listed, model: modelPlan(options, prepared) };
}

/** Inventories, reads the data, probes the target, asks the model, and puts the proposal together. */
export async function analyzeTarget(options: AnalyzeOptions): Promise<Analyzed> {
  const prepared = prepare(options);
  const { person } = options;
  const { entries, probedRows, evidenceFields, languages } = prepared;
  const [first = 'en'] = languages;
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
  // The contract a contract file states, where every probe answer keeps it (ADR-0057).
  const contract = contractStep({
    dir: options.dir,
    files: prepared.listed.files,
    request: { path: requestPath(person.url), method: 'POST' },
    textPath: probed.inference.text.path,
    evidencePaths: probed.collections.map((found) => found.match.items),
    answers: probed.answers,
  });
  if (contract.entry !== undefined) entries.push(contract.entry);
  // The model reads last. Its fields (the limits, the cache bypass, the
  // refusals) are none the data or the probes give, so they come first by
  // construction (ADR-0049); the e2e test proposes no pointer twice.
  const plan = modelPlan(options, prepared);
  let model: ModelStep | undefined;
  if (plan !== undefined && options.model !== undefined) {
    options.onModelPlan?.(plan);
    const texts = new Map<string, readonly string[]>();
    const lines = (path: string): readonly string[] => {
      const known = texts.get(path);
      if (known !== undefined) return known;
      const read = readFileSync(join(options.dir, path), 'utf8').split(/\r?\n/u);
      texts.set(path, read);
      return read;
    };
    model = await runModelStep({
      plan,
      model: options.model.config,
      caller: options.model.caller,
      languages,
      lines,
      maxCostUsd: options.model.maxCostUsd,
      cacheDir: options.model.cacheDir,
      fresh: options.model.fresh,
    });
    entries.push(...model.entries);
  }
  const mode = sessionMode({ url: person.url, headers: person.headers, body: person.body });
  return {
    inventory: prepared.listed,
    probes: probed.probes,
    contracts: contract.contracts,
    ...(model === undefined ? {} : { model }),
    entries,
    document: proposalDocument(person, mode, entries),
    exclude: personPointers(person),
    cut: prepared.cut,
    undecided: undecidedFields(probed, evidenceFields),
  };
}
