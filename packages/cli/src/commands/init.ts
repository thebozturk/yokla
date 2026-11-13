// yokla init (ADR-0018): sends the target one message, works out where the
// answer is, and writes a profile for review and the starter cases. The
// request is the person's; everything about the answer is inferred. yokla
// makes no model call; the target may make its own, as for any message.
// Nothing is written when the probe fails or the profile can't read its own
// probe, and no file is overwritten without --force.
// Exit codes: 0 the files were written; 2 they weren't.

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildRequest,
  casesYaml,
  deadlineFromProbe,
  formatIssue,
  gitignoreAdditions,
  inferResponse,
  inferSessionId,
  parseConfig,
  profileYaml,
  sessionMode,
  starterCases,
  toJson,
  type JsonValue,
  type HttpProfileTarget,
  type StarterLanguage,
} from '@yokla/core';
import { HttpClient, HttpError, type HttpResult } from '@yokla/runtime';
import { schemas } from '../schemas.ts';
import type { Output } from './run.ts';

export const INIT_HELP = `Usage: yokla init --url <url> [options]

Options:
  --url <url>           the target's chat endpoint
  --body <json>         the request body, with {{message}} where the message goes
                        (default: {"message": "{{message}}"})
  --header <name: value>  a request header; repeatable; values may use {{env.NAME}}
  --session-url <url>   a request that opens the target's session, a path or a URL;
                        its id goes to every turn as {{carry.session}}
  --text <jsonpath>     where the answer text is, when init doesn't find it
  --language <tr|en>    a language of the profile; repeatable (default: en);
                        the probe is written in the first
  --dir <path>          where to write the files (default: .)
  --force               overwrite existing files

Sends the target one message, and one more with --session-url. yokla makes no
model call; the target may make its own, as for any message. Writes
yokla.profile.yaml, cases/starter.yaml and .gitignore entries.`;

const INIT_OPTIONS = {
  url: { type: 'string' },
  body: { type: 'string' },
  header: { type: 'string', multiple: true },
  'session-url': { type: 'string' },
  text: { type: 'string' },
  language: { type: 'string', multiple: true },
  dir: { type: 'string' },
  force: { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

const GREETINGS: Readonly<Record<StarterLanguage, string>> = {
  en: 'Hello! What can you help me with?',
  tr: 'Merhaba! Bana nasıl yardımcı olabilirsin?',
};
const PROBE_TIMEOUT_MS = 120_000;

class InitError extends Error {}

function parseHeaders(lines: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) throw new InitError(`--header "${line}" is not "name: value"`);
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

function parseBody(text: string): JsonValue {
  try {
    return toJson(JSON.parse(text));
  } catch {
    throw new InitError('--body is not JSON');
  }
}

function parseLanguages(values: readonly string[] | undefined): StarterLanguage[] {
  const languages = values ?? ['en'];
  const known = languages.filter(
    (value): value is StarterLanguage => value === 'tr' || value === 'en',
  );
  if (known.length !== languages.length) throw new InitError('--language is tr or en');
  if (new Set(known).size !== known.length) throw new InitError('--language is given twice');
  return known;
}

/** A target name from the URL's host; an address or localhost names nothing. */
function nameOf(url: URL): string {
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || /^[\d.]+$/u.test(host) || host.includes(':')) return 'assistant';
  const name = host.replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/^-|-$/gu, '');
  return name === '' ? 'assistant' : name;
}

/** A path as the person will type it: relative to where they are, unless it climbs out. */
function shown(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel === '' ? '.' : rel.startsWith('..') ? path : rel;
}

async function send(
  client: HttpClient,
  request: HttpProfileTarget['request'],
  values: Parameters<typeof buildRequest>[2],
): Promise<HttpResult> {
  try {
    return await client.send(buildRequest(request, undefined, values));
  } catch (error) {
    if (error instanceof HttpError)
      throw new InitError(`the probe got no answer: ${error.message}`);
    throw error;
  }
}

export async function initCommand(
  args: readonly string[],
  io: Output,
  version: string,
  cwd: string = process.cwd(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  let values: ReturnType<
    typeof parseArgs<{ args: string[]; options: typeof INIT_OPTIONS }>
  >['values'];
  try {
    values = parseArgs({
      args: [...args],
      options: INIT_OPTIONS,
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(INIT_HELP);
    return 2;
  }
  if (values.help === true) {
    io.out(INIT_HELP);
    return 0;
  }
  try {
    return await init(values, io, version, cwd, env);
  } catch (error) {
    if (error instanceof InitError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}

async function init(
  values: ReturnType<typeof parseArgs<{ args: string[]; options: typeof INIT_OPTIONS }>>['values'],
  io: Output,
  version: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  if (values.url === undefined) throw new InitError('--url is required: the target to probe');
  let url: URL;
  try {
    url = new URL(values.url);
  } catch {
    throw new InitError(`--url "${values.url}" is not an absolute URL`);
  }
  // A WebSocket answer has no end to find without a declared done event (ADR-0024).
  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    throw new InitError(
      'init probes HTTP targets only: for a WebSocket target, write the profile by hand (see "WebSocket targets" in the profile guide)',
    );
  }
  const headers = parseHeaders(values.header ?? []);
  const body = parseBody(values.body ?? '{"message": "{{message}}"}');
  const languages = parseLanguages(values.language);
  const [first] = languages;
  if (first === undefined) throw new InitError('--language is tr or en');
  const request = {
    url: values.url,
    method: 'POST' as const,
    headers,
    body,
    timeoutMs: PROBE_TIMEOUT_MS,
  };
  if (!JSON.stringify([request.url, headers, body]).includes('{{message}}')) {
    throw new InitError(
      'the request never sends {{message}}: put it in --body, --url or a --header',
    );
  }

  const dir = resolve(cwd, values.dir ?? '.');
  const profilePath = join(dir, 'yokla.profile.yaml');
  const casesPath = join(dir, 'cases', 'starter.yaml');
  const existing = [profilePath, casesPath].filter((path) => existsSync(path));
  if (existing.length > 0 && values.force !== true) {
    throw new InitError(
      `${existing.map((path) => shown(cwd, path)).join(' and ')} already exist; --force overwrites`,
    );
  }

  const sessionUrl =
    values['session-url'] === undefined
      ? undefined
      : values['session-url'].startsWith('/')
        ? new URL(values['session-url'], url)
        : new URL(values['session-url']);
  const client = new HttpClient({
    allowedOrigins: [url.origin, ...(sessionUrl === undefined ? [] : [sessionUrl.origin])],
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const session =
    sessionMode({ url: values.url, headers, body }) === 'client' ? randomUUID() : undefined;
  const message = GREETINGS[first];
  io.out(
    `probing ${url.href}: one message; yokla makes no model call, the target may make its own`,
  );

  const carry: Record<string, JsonValue> = {};
  let sessionOpen: { url: string; from: string } | undefined;
  if (sessionUrl !== undefined) {
    const opened = await send(
      client,
      { ...request, url: sessionUrl.href, body: {} },
      { message: '', session, requestId: undefined, carry: {}, env },
    );
    if (opened.status < 200 || opened.status > 299) {
      throw new InitError(`--session-url answered ${String(opened.status)}`);
    }
    const id = inferSessionId(opened.text);
    if (id === undefined) {
      throw new InitError('--session-url answered, but no session id is in its answer');
    }
    carry['session'] = id.sample;
    sessionOpen = { url: values['session-url'] ?? sessionUrl.href, from: id.from };
    io.out(`  session: opened, id at ${id.from}`);
  }

  const answered = await send(client, request, {
    message,
    session,
    requestId: undefined,
    carry,
    env,
  });
  const outcome = inferResponse(
    {
      status: answered.status,
      contentType: answered.headers['content-type'],
      body: answered.text,
      sent: [
        message,
        ...(session === undefined ? [] : [session]),
        ...Object.values(carry).map(String),
      ],
    },
    values.text === undefined ? {} : { text: values.text },
  );
  io.out(
    `  answered ${String(answered.status)} in ${String(Math.round(answered.latencyMs))} ms (${answered.headers['content-type'] ?? 'no content type'})`,
  );
  if (!outcome.ok) {
    io.err(`yokla init wrote nothing: ${outcome.problem}`);
    io.err(`  what the answer holds: ${outcome.shape}`);
    io.err(
      '  --text <jsonpath> says where the answer text is; --body and --header change the request',
    );
    return 2;
  }
  const { inference } = outcome;
  io.out(`  answer text: ${inference.text.path} (${inference.text.rule})`);
  if (inference.response.stream !== undefined) {
    const stream = inference.response.stream;
    io.out(
      `  stream: ${stream.format}, text from ${stream.text.event} ${stream.text.from}${stream.done === undefined ? '' : `, done on ${stream.done}`}`,
    );
  }
  io.out(`  read back: ${JSON.stringify(inference.replayed.slice(0, 160))}`);
  for (const other of inference.alternatives) io.out(`  also possible: ${other.path}`);
  if (inference.route !== undefined) io.out(`  route: ${inference.route.path}`);
  for (const entry of inference.carry) io.out(`  carried: ${entry.name} from ${entry.from}`);

  const writtenBy = `yokla init ${version}`;
  const profileText = profileYaml({
    name: nameOf(url),
    url: values.url,
    headers,
    body,
    languages,
    sessionOpen,
    inference,
    writtenBy,
  });
  const canary = `YOKLA-${randomBytes(4).toString('hex').toUpperCase()}`;
  const cases = starterCases({
    languages,
    deadlineMs: deadlineFromProbe(answered.latencyMs),
    canary,
    evidence: writtenBy,
  });
  const casesText = casesYaml(cases, writtenBy);
  // Both files must load as yokla run would load them, before either is written.
  const profileParsed = parseConfig(profileText, 'yokla.profile.yaml', schemas.profile);
  const casesParsed = parseConfig(casesText, 'cases/starter.yaml', schemas.caseFile);
  const problems = [
    ...(profileParsed.ok ? [] : profileParsed.issues),
    ...(casesParsed.ok ? [] : casesParsed.issues),
  ];
  if (problems.length > 0) {
    throw new InitError(`yokla init wrote nothing: ${problems.map(formatIssue).join('; ')}`);
  }

  mkdirSync(join(dir, 'cases'), { recursive: true });
  writeFileSync(profilePath, profileText);
  writeFileSync(casesPath, casesText);
  const gitignorePath = join(dir, '.gitignore');
  const before = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const additions = gitignoreAdditions(before);
  if (additions.length > 0) {
    const separator = before === '' || before.endsWith('\n') ? '' : '\n';
    writeFileSync(gitignorePath, `${before}${separator}${additions.join('\n')}\n`);
  }

  io.out(`wrote ${shown(cwd, profilePath)}`);
  io.out(`wrote ${shown(cwd, casesPath)}: ${String(cases.length)} starter cases, proposed`);
  if (additions.length > 0)
    io.out(`added ${additions.join(' and ')} to ${shown(cwd, gitignorePath)}`);
  io.out('next: read both files, set each case you agree with to status: approved, then');
  io.out(
    `  yokla run --profile ${shown(cwd, profilePath)} --cases ${shown(cwd, join(dir, 'cases'))}`,
  );
  return 0;
}
