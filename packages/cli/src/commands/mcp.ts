// yokla mcp (ADR-0041): serves yokla's tools to a coding agent over stdio, in
// the Model Context Protocol. The person fixes the profile, cases,
// configuration, target and cost cap at start; the agent chooses which cases
// to run, explain, shrink and verify. stdout carries protocol messages only.
// Exit codes: 0 the client closed the session; 2 a configuration problem.

import { resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { ConfigError } from '@yokla/runtime';
import { LoadError } from '../load.ts';
import { mcpServer, serveLines } from '../mcp/protocol.ts';
import { canSpend, Session, sessionTools } from '../mcp/tools.ts';
import { loadFiles, readCassette } from '../prepare.ts';
import type { Output } from './run.ts';

export const MCP_HELP = `Usage: yokla mcp [options]

Serves run_cases, explain_finding, shrink_case, verify_fix and list_cases to a
coding agent over stdio, in the Model Context Protocol. No tool takes a path or
a url: the options below fix what the agent can reach.

Options:
  --profile <file>      the profile (default: yokla.profile.yaml)
  --cases <path>        a case file or directory; repeatable (default: cases)
  --config <file>       prices, models and check modules (default: yokla.config.yaml, when present)
  --target-url <url>    use this url instead of the profile's request url
  --proxy-url <url>     the model proxy, instead of 127.0.0.1 on modelProxy.port
  --out <dir>           where every run's results go (default: runs)
  --max-cost <usd>      the session's cost cap over every run; required when it can spend
  --replay <file>       answer every run's model calls from a cassette, calling no provider
  --replay-loose        with --replay, answer a call the cassette has no match for by position`;

const OPTIONS = {
  profile: { type: 'string', default: 'yokla.profile.yaml' },
  cases: { type: 'string', multiple: true },
  config: { type: 'string' },
  'target-url': { type: 'string' },
  'proxy-url': { type: 'string' },
  out: { type: 'string', default: 'runs' },
  'max-cost': { type: 'string' },
  replay: { type: 'string' },
  'replay-loose': { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

/** What yokla mcp tells a client about itself when it initializes. */
const INSTRUCTIONS =
  "yokla tests a conversational assistant end to end. Run the cases with run_cases; read a failing case with explain_finding, which says where a wrong value arose; cut it down with shrink_case; after changing the assistant, check the fix with verify_fix against the run that failed. Every paid run counts against the session's cost cap.";

export async function mcpCommand(
  args: readonly string[],
  io: Output,
  version: string,
  stdio: { readonly input: Readable; readonly output: Writable } = {
    input: process.stdin,
    output: process.stdout,
  },
): Promise<number> {
  let values;
  try {
    values = parseArgs({ args: [...args], options: OPTIONS, strict: true }).values;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(MCP_HELP);
    return 2;
  }
  if (values.help === true) {
    io.err(MCP_HELP);
    return 0;
  }
  try {
    const maxCost = values['max-cost'] === undefined ? undefined : Number(values['max-cost']);
    if (maxCost !== undefined && !(Number.isFinite(maxCost) && maxCost > 0)) {
      throw new LoadError('--max-cost must be a positive number of USD');
    }
    if (values['replay-loose'] === true && values.replay === undefined) {
      throw new LoadError('--replay-loose needs --replay');
    }
    const settings = {
      profile: values.profile,
      cases: values.cases,
      config: values.config,
      targetUrl: values['target-url'],
      proxyUrl: values['proxy-url'],
      out: resolve(values.out),
      maxCostUsd: maxCost,
      replay: values.replay,
      replayLoose: values['replay-loose'],
    };
    // The files must load before the session starts, and say whether it can spend.
    const prepared = await loadFiles(settings);
    if (values.replay !== undefined) readCassette(values.replay);
    if (maxCost === undefined && canSpend(prepared, values.replay !== undefined)) {
      throw new LoadError(
        'this session can spend money on model calls: start yokla mcp with --max-cost <usd>, its cap over every run (ADR-0041)',
      );
    }
    const session = new Session(settings);
    io.err(
      `yokla mcp: serving ${String(prepared.cases.length)} cases of ${prepared.profile.target.name} over stdio${maxCost === undefined ? '' : `, capped at ${String(maxCost)} USD`}`,
    );
    await serveLines(
      stdio.input,
      stdio.output,
      mcpServer({ name: 'yokla', version, instructions: INSTRUCTIONS }, sessionTools(session)),
    );
    return 0;
  } catch (error) {
    if (error instanceof LoadError || error instanceof ConfigError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}
