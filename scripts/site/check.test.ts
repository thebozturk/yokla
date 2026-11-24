import { describe, expect, it } from 'vitest';
import { externalLoadsInCss, externalLoadsInHtml, isExternal, missingGuidePages } from './check.ts';

// The documentation site loads nothing from another host, and holds every
// guide page (ADR-0098): the checks catch each way it could go wrong.

describe('loads from another host (ADR-0098)', () => {
  it('tells another host’s address from the site’s own', () => {
    expect(
      [
        'https://cdn.example/a.js',
        '//cdn.example/a.js',
        'HTTP://x',
        '/yokla/a.js',
        'a.js',
        '#x',
        'data:image/png;base64,x',
      ].map(isExternal),
    ).toEqual([true, true, true, false, false, false, false]);
  });

  it('finds a script, an image, a frame and a stylesheet from another host', () => {
    const html = [
      '<script type="module" src="https://cdn.example/app.js"></script>',
      '<script src="/yokla/assets/app.js"></script>',
      "<img alt='x' src='//images.example/a.png'>",
      '<iframe src=https://embed.example/v></iframe>',
      '<link rel="stylesheet" href="https://fonts.example/css">',
      '<link rel="preload stylesheet" href="https://fonts.example/b.woff2">',
      '<link rel="modulepreload" href="/yokla/assets/chunk.js">',
      '<style>@import url("https://fonts.example/c.css"); .a { background: url(/yokla/a.png) }</style>',
    ].join('\n');
    expect(externalLoadsInHtml(html)).toEqual([
      'https://cdn.example/app.js',
      '//images.example/a.png',
      'https://embed.example/v',
      'https://fonts.example/css',
      'https://fonts.example/b.woff2',
      'https://fonts.example/c.css',
    ]);
  });

  it('leaves a link that only links, and an icon of the site’s own', () => {
    const html = [
      '<a href="https://github.com/thebozturk/yokla">GitHub</a>',
      '<link rel="canonical" href="https://thebozturk.github.io/yokla/">',
      '<link rel="icon" href="/yokla/favicon.svg">',
    ].join('\n');
    expect(externalLoadsInHtml(html)).toEqual([]);
  });

  it('finds a font or an import from another host in a stylesheet', () => {
    const css =
      "@font-face { src: url('https://fonts.example/a.woff2') } @import 'https://x.example/b.css'; .c { background: url(data:image/png;base64,x) } .d { background: url(./e.png) }";
    expect(externalLoadsInCss(css)).toEqual([
      'https://fonts.example/a.woff2',
      'https://x.example/b.css',
    ]);
  });
});

describe('the guide’s pages on the site (ADR-0098)', () => {
  const sidebar =
    '<a href="/yokla/guide/README.html">A first run</a><a href="/yokla/guide/ci.html">CI</a>';

  it('passes when every page is built and in the sidebar', () => {
    const built = new Set(['guide/README.html', 'guide/ci.html']);
    expect(missingGuidePages(['README.md', 'ci.md'], built, sidebar, '/yokla/')).toEqual([]);
  });

  it('names a page that isn’t built, and one the sidebar leaves out', () => {
    const built = new Set(['guide/README.html', 'guide/new.html']);
    expect(missingGuidePages(['README.md', 'ci.md', 'new.md'], built, sidebar, '/yokla/')).toEqual([
      'ci.md: not built',
      "new.md: not in the guide's sidebar",
    ]);
  });
});
