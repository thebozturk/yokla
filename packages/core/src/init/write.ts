// The files yokla init writes (ADR-0018): the profile, with a comment on
// every inferred line naming the rule that chose it, and the starter cases.
// They hold the request as the person gave it, never the target's answers.
// Pure: the CLI writes the text to disk.

import { Document, isMap, isScalar } from 'yaml';
import type { JsonValue } from '../extract/response.ts';
import type { Inference } from './infer.ts';

export interface ProfileInput {
  readonly name: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: JsonValue | undefined;
  readonly languages: readonly string[];
  /** A request that opens the target's session, and where its id is (ADR-0016). */
  readonly sessionOpen: { readonly url: string; readonly from: string } | undefined;
  readonly inference: Inference;
  /** "yokla init <version>", for the header. */
  readonly writtenBy: string;
}

/** client when the request sends yokla's own {{session}} id, none otherwise. */
export function sessionMode(
  input: Pick<ProfileInput, 'url' | 'headers' | 'body'>,
): 'client' | 'none' {
  return JSON.stringify([input.url, input.headers, input.body ?? null]).includes('{{session}}')
    ? 'client'
    : 'none';
}

/** Puts a comment line above the key at `path` in the document. */
function commentKey(doc: Document, path: readonly string[], comment: string): void {
  const parent: unknown = doc.getIn(path.slice(0, -1), true);
  if (!isMap(parent)) return;
  const pair = parent.items.find((item) => isScalar(item.key) && item.key.value === path.at(-1));
  if (pair !== undefined && isScalar(pair.key)) pair.key.commentBefore = ` ${comment}`;
}

/** The profile yokla init writes, as YAML text with comments. */
export function profileYaml(input: ProfileInput): string {
  const { inference } = input;
  const carry = inference.carry.map(({ name, from }) => ({ name, from }));
  const target = {
    name: input.name,
    adapter: 'http',
    request: {
      url: input.url,
      ...(Object.keys(input.headers).length === 0 ? {} : { headers: input.headers }),
      ...(input.body === undefined ? {} : { body: input.body }),
    },
    response: inference.response,
    session: {
      mode: sessionMode(input),
      ...(carry.length === 0 ? {} : { carry }),
      ...(input.sessionOpen === undefined
        ? {}
        : {
            open: {
              request: { url: input.sessionOpen.url, body: {} },
              carry: [{ name: 'session', from: input.sessionOpen.from }],
            },
          }),
    },
  };
  const doc = new Document(
    { version: 1, target, languages: input.languages, domain: 'ecommerce' },
    { aliasDuplicateObjects: false },
  );
  doc.commentBefore = [
    ` Written by ${input.writtenBy} from one probe of the target. Review every`,
    ' line: the comments say which rule chose what. docs/guide/profile.md',
    ' describes each field; `yokla schema profile` prints the JSON Schema for an',
    ' editor.',
  ].join('\n');

  const others = inference.alternatives.map((candidate) => candidate.path);
  const textComment = `${inference.text.rule}${others.length === 0 ? '' : `; other candidates: ${others.join(', ')}`}`;
  if (inference.response.stream === undefined) {
    commentKey(doc, ['target', 'response', 'text'], textComment);
  } else {
    const done = inference.response.stream.done;
    commentKey(
      doc,
      ['target', 'response', 'stream'],
      `the event whose pieces read like an answer: ${textComment}${done === undefined ? '' : `; done: the last event, which came once`}`,
    );
    commentKey(doc, ['target', 'response', 'text'], 'the stream document joins the text pieces');
  }
  if (inference.route !== undefined) {
    commentKey(doc, ['target', 'response', 'route'], inference.route.rule);
  }
  commentKey(
    doc,
    ['target', 'session', 'mode'],
    'client: the request sends {{session}}, a new id per sample; none: it does not',
  );
  if (carry.length > 0) {
    commentKey(
      doc,
      ['target', 'session', 'carry'],
      'ids the answer issues; send them back as {{carry.NAME}} in the body or headers',
    );
  }
  if (input.sessionOpen !== undefined) {
    commentKey(
      doc,
      ['target', 'session', 'open'],
      'opens the session before the first turn; its id goes to every turn as {{carry.session}}',
    );
  }
  doc.comment = [
    ' Left out: evidence (the products an answer shows), rate limits, the cache',
    ' bypass, log observation and the model proxy. See docs/guide/profile.md.',
  ].join('\n');
  return doc.toString({ lineWidth: 100 });
}

/** The starter cases file, as YAML text with comments. */
export function casesYaml(cases: readonly Record<string, unknown>[], writtenBy: string): string {
  // No anchors: a shared node would approve every case at once.
  const doc = new Document({ version: 1, cases }, { aliasDuplicateObjects: false });
  doc.commentBefore = [
    ` Starter cases written by ${writtenBy}: what holds for any assistant,`,
    ' judged by deterministic checks only. They run, but gate only once a person',
    ' reads each and sets its status to approved (ADR-0004). See docs/guide/cases.md.',
  ].join('\n');
  return doc.toString({ lineWidth: 100 });
}

/** Lines `.gitignore` needs for yokla's outputs that it doesn't have yet (design §15). */
export function gitignoreAdditions(existing: string): string[] {
  const lines = new Set(existing.split(/\r?\n/u).map((line) => line.trim()));
  return ['runs/', 'yokla-data/'].filter(
    (entry) => !lines.has(entry) && !lines.has(entry.slice(0, -1)) && !lines.has(`/${entry}`),
  );
}
