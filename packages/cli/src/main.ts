// The yokla command line.

import { readFileSync } from 'node:fs';
import { BASELINE_HELP, baselineCommand } from './commands/baseline.ts';
import { COMPARE_HELP, compareCommand } from './commands/compare.ts';
import { GATE_HELP, gateCommand } from './commands/gate.ts';
import { INIT_HELP, initCommand } from './commands/init.ts';
import { MCP_HELP, mcpCommand } from './commands/mcp.ts';
import { PLAN_HELP, planCommand } from './commands/plan.ts';
import { PROXY_HELP, proxyCommand } from './commands/proxy.ts';
import { REPORT_HELP, reportCommand } from './commands/report.ts';
import { RUN_HELP, runCommand, type Output } from './commands/run.ts';
import { SHRINK_HELP, shrinkCommand } from './commands/shrink.ts';
import { jsonSchemas } from './schemas.ts';

const HELP = `yokla — test conversational AI assistants end to end

Usage:
  yokla init [options]       write a first profile and starter cases from one message
  yokla run [options]        run cases against the profile's target
  yokla report [options]     render the reports of a results file
  yokla gate [options]       judge a results file; exit 0, 1 or 2
  yokla baseline [options]   accept a run as the baseline
  yokla proxy [options]      run the model proxy until stopped
  yokla plan [options]       estimate the cost of a run from a calibration
  yokla shrink [options]     cut a failing case down to the smallest that still fails
  yokla mcp [options]        serve yokla's tools to a coding agent over stdio (MCP)
  yokla compare [options]    set runs side by side, such as one per model, and name the cheapest that passes
  yokla schema <name>        print a JSON Schema: profile, cases, config, results, baseline, comparison
  yokla --version

${INIT_HELP}

${RUN_HELP}

${REPORT_HELP}

${GATE_HELP}

${BASELINE_HELP}

${PROXY_HELP}

${PLAN_HELP}

${SHRINK_HELP}

${MCP_HELP}

${COMPARE_HELP}`;

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
  config: 'config.v1.schema.json',
  results: 'results.v1.schema.json',
  baseline: 'baseline.v1.schema.json',
  comparison: 'comparison.v1.schema.json',
};

export async function main(argv: readonly string[], io: Output): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'init':
      return initCommand(rest, io, version());
    case 'run':
      return runCommand(rest, io, version());
    case 'report':
      return reportCommand(rest, io);
    case 'gate':
      return gateCommand(rest, io);
    case 'baseline':
      return baselineCommand(rest, io);
    case 'proxy':
      return proxyCommand(rest, io);
    case 'plan':
      return planCommand(rest, io);
    case 'shrink':
      return shrinkCommand(rest, io, version());
    case 'mcp':
      return mcpCommand(rest, io, version());
    case 'compare':
      return compareCommand(rest, io);
    case 'schema': {
      const file = SCHEMA_FILES[rest[0] ?? ''];
      if (file === undefined) {
        io.err('usage: yokla schema <profile|cases|config|results|baseline|comparison>');
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
