// Publishes one tarball the release checked, unless the registry already
// holds its version (ADR-0071): the same tarball is skipped, as a resumed
// release finds it; another one stops the release. The release workflow runs
// it for each line of publish-order.txt, in order.
// Usage: node scripts/publish-tarball.ts <tarball>

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { publishDecision } from './pack/check.ts';

function fail(message: string): never {
  console.error(`publish: ${message}`);
  process.exit(1);
}

function run(command: string, args: readonly string[]): { status: number | null; stdout: string } {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error !== undefined) fail(result.error.message);
  return { status: result.status, stdout: result.stdout };
}

const tarball = process.argv[2] ?? fail('usage: node scripts/publish-tarball.ts <tarball>');
const manifest: unknown = JSON.parse(run('tar', ['-xzOf', tarball, 'package/package.json']).stdout);
const name: unknown = Reflect.get(Object(manifest), 'name');
const version: unknown = Reflect.get(Object(manifest), 'version');
if (typeof name !== 'string' || typeof version !== 'string') {
  fail(`${tarball}: no name or version in its package.json`);
}
const spec = `${name}@${version}`;
const local = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
// An unknown version prints nothing; an unknown package exits non-zero. Either way: not published.
const viewed = run('npm', ['view', spec, 'dist.integrity', '--prefer-online']);
const printed = viewed.stdout.trim();
const decision = publishDecision(
  spec,
  local,
  viewed.status === 0 && printed !== '' ? printed : undefined,
);
if (decision.action === 'stop') fail(decision.reason);
if (decision.action === 'skip') {
  console.log(`publish: ${decision.reason}; skipped`);
} else {
  const published = spawnSync('npm', ['publish', tarball, '--access', 'public'], {
    stdio: 'inherit',
  });
  if (published.status !== 0)
    fail(`npm publish ${tarball} exited with ${String(published.status)}`);
}
