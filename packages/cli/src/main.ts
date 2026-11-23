// The yokla command line.

import { ANALYZE_HELP, analyzeCommand } from './commands/analyze.ts';
import { BASELINE_HELP, baselineCommand } from './commands/baseline.ts';
import { COMPARE_HELP, compareCommand } from './commands/compare.ts';
import { EXPLORE_HELP, exploreCommand } from './commands/explore.ts';
import { GENERATE_HELP, generateCommand } from './commands/generate.ts';
import { GATE_HELP, gateCommand } from './commands/gate.ts';
import { INIT_HELP, initCommand } from './commands/init.ts';
import { MCP_HELP, mcpCommand } from './commands/mcp.ts';
import { PLAN_HELP, planCommand } from './commands/plan.ts';
import { PROXY_HELP, proxyCommand } from './commands/proxy.ts';
import { REPORT_HELP, reportCommand } from './commands/report.ts';
import { RUN_HELP, runCommand, type Output } from './commands/run.ts';
import { SHRINK_HELP, shrinkCommand } from './commands/shrink.ts';
import { jsonSchemas } from './schemas.ts';
import { version } from './version.ts';

const HELP = `yokla — test conversational AI assistants end to end

Usage:
  yokla init [options]       write a first profile and starter cases from one message
  yokla analyze [options]    propose a profile from the target's repository, data and probes
  yokla run [options]        run cases against the profile's target
  yokla report [options]     render the reports of a results file
  yokla gate [options]       judge a results file; exit 0, 1 or 2
  yokla baseline [options]   accept a run as the baseline
  yokla proxy [options]      run the model proxy until stopped
  yokla plan [options]       estimate the cost of a run from a calibration
  yokla shrink [options]     cut a failing case down to the smallest that still fails
  yokla mcp [options]        serve yokla's tools to a coding agent over stdio (MCP)
  yokla compare [options]    set runs side by side, such as one per model, and name the cheapest that passes
  yokla explore [options]    search for paths the written cases never take, and propose cases for them
  yokla generate [options]   propose cases whose expectations the domain pack computes from the data
  yokla schema <name>        print a JSON Schema: profile, cases, config, results, baseline, comparison,
                             analysis
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

${COMPARE_HELP}

${EXPLORE_HELP}

${GENERATE_HELP}

${ANALYZE_HELP}`;

const SCHEMA_FILES: Readonly<Record<string, string>> = {
  profile: 'profile.v1.schema.json',
  cases: 'cases.v1.schema.json',
  config: 'config.v1.schema.json',
  results: 'results.v1.schema.json',
  baseline: 'baseline.v1.schema.json',
  comparison: 'comparison.v1.schema.json',
  analysis: 'analysis.v1.schema.json',
};

export async function main(argv: readonly string[], io: Output): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'init':
      return initCommand(rest, io, version());
    case 'run':
      return runCommand(rest, io);
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
      return shrinkCommand(rest, io);
    case 'mcp':
      return mcpCommand(rest, io, version());
    case 'compare':
      return compareCommand(rest, io);
    case 'explore':
      return exploreCommand(rest, io);
    case 'generate':
      return generateCommand(rest, io);
    case 'analyze':
      return analyzeCommand(rest, io, version());
    case 'schema': {
      const file = SCHEMA_FILES[rest[0] ?? ''];
      if (file === undefined) {
        io.err('usage: yokla schema <profile|cases|config|results|baseline|comparison|analysis>');
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
