import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The CLI's README is its npm page. It is the repository's README, with
// absolute links, so both read the same on GitHub and on npm.

/** The targets of the Markdown links in a text that npm couldn't follow. */
function relativeLinks(text: string): string[] {
  return [...text.matchAll(/\]\(([^)]+)\)/gu)]
    .map((match) => match[1] ?? '')
    .filter((target) => !target.startsWith('https://'));
}

describe('the READMEs', () => {
  const root = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  it('the CLI package ships the repository README', () => {
    const cli = readFileSync(new URL('../packages/cli/README.md', import.meta.url), 'utf8');
    expect(cli).toBe(root);
  });

  it('every link works outside GitHub: none is relative', () => {
    expect(root).toContain('](https://');
    expect(relativeLinks(root)).toEqual([]);
  });

  it('the guide shows the library API example pack-check runs (ADR-0093)', () => {
    const page = readFileSync(new URL('../docs/guide/api.md', import.meta.url), 'utf8');
    const example = readFileSync(
      new URL('../packages/cli/examples/run-and-gate.ts', import.meta.url),
      'utf8',
    );
    expect(page).toContain(`\`\`\`ts\n${example}\`\`\`\n`);
  });

  it('finds a relative link, and only that', () => {
    expect(
      relativeLinks('[a](docs/guide.md) [b](https://x.example/) [c](#install) [d](http://x)'),
    ).toEqual(['docs/guide.md', '#install', 'http://x']);
  });
});
