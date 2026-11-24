import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GUIDE, outsideLink } from '../../docs/.vitepress/config.ts';

// The site's configuration (ADR-0098): a link that leaves docs/ points to the
// file on GitHub, and the guide's sidebar holds every page of docs/guide.

describe('links that leave docs/ (ADR-0098)', () => {
  it('points them to the file on GitHub', () => {
    expect(outsideLink('guide/cases.md', '../../packages/cli/schemas/cases.v1.schema.json')).toBe(
      'https://github.com/thebozturk/yokla/blob/main/packages/cli/schemas/cases.v1.schema.json',
    );
    expect(outsideLink('guide/README.md', '../../examples/demo-shop/README.md#defects')).toBe(
      'https://github.com/thebozturk/yokla/blob/main/examples/demo-shop/README.md#defects',
    );
    expect(outsideLink('index.md', '../CHANGELOG.md')).toBe(
      'https://github.com/thebozturk/yokla/blob/main/CHANGELOG.md',
    );
  });

  it('leaves a link that stays in docs/, an anchor, a site path and another site', () => {
    expect([
      outsideLink('guide/cases.md', '../adr/0004-expectations-from-claims-and-data.md'),
      outsideLink('guide/cases.md', 'checks.md#price-grounded'),
      outsideLink('guide/cases.md', '#the-case'),
      outsideLink('guide/cases.md', '/guide/cli'),
      outsideLink('guide/cases.md', 'https://example.com/a'),
      outsideLink('guide/cases.md', 'mailto:someone@example.com'),
    ]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  });
});

describe('the guide’s sidebar (ADR-0098)', () => {
  it('lists every page of docs/guide, once', () => {
    const pages = readdirSync(new URL('../../docs/guide/', import.meta.url))
      .filter((file) => file.endsWith('.md'))
      .map((file) => `/guide/${file.replace(/\.md$/u, '')}`)
      .toSorted((a, b) => a.localeCompare(b));
    const listed = GUIDE.map((item) => item.link ?? '').toSorted((a, b) => a.localeCompare(b));
    expect(listed).toEqual(pages);
  });
});
