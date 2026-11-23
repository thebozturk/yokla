// yokla's version, from the package's manifest: what the CLI prints and every
// run records (ADR-0093 keeps it apart from main.ts, so the API needs no CLI).

import { readFileSync } from 'node:fs';

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
