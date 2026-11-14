// Packs every published package and checks what each tarball holds, then
// installs the tarballs into an empty project and runs the CLI from there
// (ADR-0034). Nothing is published.
// Run from the repository root after a build: pnpm pack-check

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { checkPacked } from './pack/check.ts';

/** Workspace folders whose packages are published; the demo-shop and the scripts are not. */
const PUBLISHED_GROUPS = ['packages', 'packs'] as const;
/** The smoke install takes only releases at least this old, as the workspace does (ADR-0006). */
const MINIMUM_RELEASE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEMO_SHOP_START_TIMEOUT_MS = 10_000;

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(text: string, where: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  return isRecord(value) ? value : fail(`${where}: expected a JSON object`);
}

/** Runs a command to completion; fails with its output unless it exits with 0. */
function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(' ')} exited with ${String(result.status)}\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

function publishedDirs(): string[] {
  return PUBLISHED_GROUPS.flatMap((group) =>
    readdirSync(group, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(group, entry.name, 'package.json')))
      .map((entry) => posix.join(group, entry.name)),
  );
}

interface Packed {
  readonly name: string;
  readonly version: string;
  readonly tarball: string;
}

function pack(dir: string, destination: string): Packed {
  const output = parseObject(
    run('pnpm', ['pack', '--pack-destination', destination, '--json'], dir),
    `pnpm pack in ${dir}`,
  );
  const { name, version, filename } = output;
  if (typeof name !== 'string' || typeof version !== 'string' || typeof filename !== 'string') {
    return fail(`pnpm pack in ${dir}: no name, version or filename in its output`);
  }
  return { name, version, tarball: filename };
}

/** Checks one tarball; returns the problems, each prefixed with the package name. */
function inspect(packed: Packed): string[] {
  const files = run('tar', ['-tzf', packed.tarball], '.')
    .split('\n')
    .filter((line) => line !== '' && !line.endsWith('/'))
    .map((line) => (line.startsWith('package/') ? line.slice('package/'.length) : line));
  const manifest = parseObject(
    run('tar', ['-xzOf', packed.tarball, 'package/package.json'], '.'),
    `${packed.tarball}: package/package.json`,
  );
  return checkPacked({ files, manifest }).map(
    (problem) => `${packed.name}: ${problem.kind}: ${problem.message}`,
  );
}

/** An empty project that depends on every tarball, with outside dependencies from the registry. */
function install(packages: readonly Packed[], project: string): void {
  mkdirSync(project);
  const tarballs = Object.fromEntries(packages.map((p) => [p.name, `file:${p.tarball}`]));
  const manifest = {
    name: 'yokla-pack-check',
    private: true,
    type: 'module',
    dependencies: tarballs,
    // The packages depend on each other by version, which no registry holds yet.
    overrides: tarballs,
  };
  writeFileSync(join(project, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const before = new Date(Date.now() - MINIMUM_RELEASE_AGE_MS).toISOString();
  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', `--before=${before}`],
    project,
  );
}

/** Starts the demo-shop from the repository on a free port; returns it and its chat URL. */
async function startDemoShop(): Promise<{ readonly child: ChildProcess; readonly url: string }> {
  const child = spawn(process.execPath, ['examples/demo-shop/src/main.ts', '--port', '0'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const timer = setTimeout(() => child.kill(), DEMO_SHOP_START_TIMEOUT_MS);
  let output = '';
  child.stdout?.setEncoding('utf8');
  try {
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout?.on('data', (chunk: string) => {
        output += chunk;
        const base = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
        if (base !== undefined) resolve(`${base}/v1/chat`);
      });
      child.on('exit', () => reject(new Error(`demo-shop exited before it listened:\n${output}`)));
      child.on('error', reject);
    });
    return { child, url };
  } finally {
    clearTimeout(timer);
  }
}

async function smoke(packages: readonly Packed[], workDir: string): Promise<void> {
  const cli = packages.find((p) => p.name === 'yokla') ?? fail('no package is named yokla');
  const project = join(workDir, 'project');
  install(packages, project);
  const yokla = join(project, 'node_modules', '.bin', 'yokla');

  const version = run(yokla, ['--version'], project).trim();
  if (version !== cli.version) fail(`yokla --version printed "${version}", not ${cli.version}`);
  console.log(`pack-check: yokla --version: ${version}`);

  const printed = JSON.parse(run(yokla, ['schema', 'results'], project)) as unknown;
  const committed = JSON.parse(
    readFileSync('packages/cli/schemas/results.v1.schema.json', 'utf8'),
  ) as unknown;
  if (JSON.stringify(printed) !== JSON.stringify(committed)) {
    fail('yokla schema results differs from packages/cli/schemas/results.v1.schema.json');
  }
  console.log('pack-check: yokla schema results: the committed schema');

  const { child, url } = await startDemoShop();
  try {
    const starter = join(workDir, 'starter');
    run(
      yokla,
      [
        'init',
        '--url',
        url,
        '--body',
        '{"message": "{{message}}", "sessionId": "{{session}}"}',
        '--dir',
        starter,
      ],
      project,
    );
    const summary = run(
      yokla,
      ['run', '--profile', 'yokla.profile.yaml', '--cases', 'cases'],
      starter,
    );
    const results = readdirSync(join(starter, 'runs')).filter((file) => file.endsWith('.json'));
    if (results.length !== 1) fail(`yokla run wrote ${String(results.length)} results files`);
    console.log(`pack-check: yokla run of the starter cases against the demo-shop:\n${summary}`);
  } finally {
    child.kill();
  }
}

const workDir = mkdtempSync(join(tmpdir(), 'yokla-pack-check-'));
try {
  const tarballs = join(workDir, 'tarballs');
  mkdirSync(tarballs);
  const packages = publishedDirs().map((dir) => pack(dir, tarballs));
  const problems = packages.flatMap(inspect);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`pack-check: ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(
      `pack-check: ${String(packages.length)} packages hold what they should: ${packages.map((p) => p.name).join(', ')}`,
    );
    await smoke(packages, workDir);
    console.log('pack-check: the packed packages install and run');
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
