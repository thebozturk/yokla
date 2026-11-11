// yokla proxy (ADR-0012): runs the model proxy until stopped. The app is
// pointed at it once; runs open a recording through its control endpoint.
// Exit codes: 0 stopped; 2 a configuration problem or a port in use.

import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { storePrompt, type ProxyRecord } from '@yokla/core';
import { startProxy } from '@yokla/proxy';
import { LoadError, loadProfile } from '../load.ts';
import type { Output } from './run.ts';

export const PROXY_HELP = `Usage: yokla proxy [options]

Options:
  --profile <file>      the profile with a modelProxy section (default: yokla.profile.yaml)
  --port <n>            listen here instead of modelProxy.port (0 picks a free port)
  --records <file>      also append each recorded call to this JSON Lines file,
                        with prompts kept as modelProxy.prompts.store says

The proxy listens on 127.0.0.1 only and records calls only while a run has a
recording open. Stop it with Ctrl-C.`;

const PROXY_OPTIONS = {
  profile: { type: 'string', default: 'yokla.profile.yaml' },
  port: { type: 'string' },
  records: { type: 'string' },
  help: { type: 'boolean' },
} as const;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function port(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 65_535)
    throw new LoadError('--port must be an integer from 0 to 65535');
  return number;
}

/** Runs until `stop` aborts, or SIGINT or SIGTERM when no signal is given. */
export async function proxyCommand(
  args: readonly string[],
  io: Output,
  stop?: AbortSignal,
): Promise<number> {
  let values: ReturnType<
    typeof parseArgs<{ args: string[]; options: typeof PROXY_OPTIONS }>
  >['values'];
  try {
    values = parseArgs({
      args: [...args],
      options: PROXY_OPTIONS,
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(PROXY_HELP);
    return 2;
  }
  if (values.help === true) {
    io.out(PROXY_HELP);
    return 0;
  }

  let config;
  let listen: number;
  try {
    config = loadProfile(values.profile).profile.modelProxy;
    if (config === undefined)
      throw new LoadError(`${values.profile}: the profile has no modelProxy section`);
    listen = port(values.port) ?? config.port;
  } catch (error) {
    if (error instanceof LoadError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }

  const records = values.records === undefined ? undefined : resolve(values.records);
  let running;
  try {
    running = await startProxy({
      port: listen,
      upstreams: config.upstreams,
      ...(records === undefined
        ? {}
        : {
            onRecord: (record: ProxyRecord) => {
              // The file keeps of each prompt what the profile's prompts.store keeps (ADR-0015).
              const stored =
                record.prompt === undefined
                  ? record
                  : { ...record, prompt: storePrompt(record.prompt, config.prompts, sha256) };
              appendFileSync(records, `${JSON.stringify(stored)}\n`);
            },
          }),
    });
  } catch (error) {
    io.err(
      `the proxy can't listen on 127.0.0.1:${String(listen)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }

  io.out(`proxy: ${running.url} (127.0.0.1 only)`);
  for (const upstream of config.upstreams) {
    const setting =
      upstream.appBaseUrlEnv === undefined
        ? ''
        : ` (${upstream.appBaseUrlEnv}=${running.url}/${upstream.id})`;
    io.out(`  ${running.url}/${upstream.id} → ${upstream.upstream}${setting}`);
  }
  if (records !== undefined) io.out(`  records: ${records}`);

  await new Promise<void>((done) => {
    if (stop !== undefined) {
      if (stop.aborted) done();
      else
        stop.addEventListener(
          'abort',
          () => {
            done();
          },
          { once: true },
        );
      return;
    }
    process.once('SIGINT', () => {
      done();
    });
    process.once('SIGTERM', () => {
      done();
    });
  });
  await running.close();
  io.out('proxy: stopped');
  return 0;
}
