// Checks the built documentation site (ADR-0098): every guide page built and
// in the sidebar, and nothing loaded from another host. Run after the build:
// pnpm site && node scripts/site-check.ts

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { externalLoadsInCss, externalLoadsInHtml, missingGuidePages } from './site/check.ts';

const DIST = 'docs/.vitepress/dist';
const BASE = '/yokla/';

/** Every file under a directory, by its path relative to it. */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

/** What a built file loads from another host. */
function loadsOf(file: string): string[] {
  if (file.endsWith('.html')) return externalLoadsInHtml(readFileSync(join(DIST, file), 'utf8'));
  if (file.endsWith('.css')) return externalLoadsInCss(readFileSync(join(DIST, file), 'utf8'));
  return [];
}

const built = files(DIST);
const problems = built.flatMap((file) =>
  loadsOf(file).map((load) => `${file}: loads ${load}, from another host`),
);
const pages = readdirSync('docs/guide').filter((file) => file.endsWith('.md'));
problems.push(
  ...missingGuidePages(
    pages,
    new Set(built),
    readFileSync(join(DIST, 'guide/README.html'), 'utf8'),
    BASE,
  ),
);

if (problems.length > 0) {
  for (const problem of problems) console.error(`site-check: ${problem}`);
  process.exitCode = 1;
} else {
  console.log(
    `site-check: ${String(built.length)} files load nothing from another host; ${String(pages.length)} guide pages built and in the sidebar`,
  );
}
