// The yokla command line.

import { readFileSync } from 'node:fs';
import { RUN_HELP, runCommand, type Output } from './commands/run.ts';
import { jsonSchemas } from './schemas.ts';

const HELP = `yokla — test conversational AI assistants end to end

Usage:
  yokla run [options]        run cases against the profile's target
  yokla schema <name>        print the JSON Schema of profile, cases or results
  yokla --version

${RUN_HELP}`;

export function version(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  return typeof manifest === 'object' &&
    manifest !== null &&
    'version' in manifest &&
    typeof manifest.version === 'string'
    ? manifest.version
    : '0.0.0';
}

const SCHEMA_FILES: Readonly<Record<string, string>> = {
  profile: 'profile.v1.schema.json',
  cases: 'cases.v1.schema.json',
  results: 'results.v1.schema.json',
};

export async function main(argv: readonly string[], io: Output): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'run':
      return runCommand(rest, io, version());
    case 'schema': {
      const file = SCHEMA_FILES[rest[0] ?? ''];
      if (file === undefined) {
        io.err('usage: yokla schema <profile|cases|results>');
        return 2;
      }
      io.out(JSON.stringify(jsonSchemas()[file], null, 2));
      return 0;
    }
    case '--version':
    case '-v':
      io.out(version());
      return 0;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      io.out(HELP);
      return 0;
    default:
      io.err(`unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}
