// Checks of the built documentation site (ADR-0098): nothing a page loads
// comes from another host, and every guide page is built and in the guide's
// sidebar. Pure: scripts/site-check.ts reads the files.

/** Elements whose `src` loads what it names. */
const LOADING_SOURCES =
  /<(?:script|img|iframe|source|video|audio|embed|track)\b[^>]*?\ssrc\s*=\s*["']?([^"'\s>]+)/giu;
/** `<link>` elements, whose `rel` says whether their `href` loads. */
const LINKS = /<link\b[^>]*>/giu;
const LOADING_RELS = new Set([
  'stylesheet',
  'preload',
  'modulepreload',
  'prefetch',
  'icon',
  'manifest',
  'apple-touch-icon',
]);
/** What a style loads: `url()` and `@import`. */
const STYLE_LOADS = /url\(\s*["']?([^"')\s]+)|@import\s+(?:url\()?\s*["']?([^"')\s;]+)/giu;

/** Whether an address points to another host: an absolute or protocol-relative URL. */
export function isExternal(address: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//iu.test(address.trim());
}

/** What a stylesheet loads from another host. */
export function externalLoadsInCss(css: string): string[] {
  const loads: string[] = [];
  for (const match of css.matchAll(STYLE_LOADS)) {
    const address = match[1] ?? match[2] ?? '';
    if (isExternal(address)) loads.push(address);
  }
  return loads;
}

/** What an HTML page loads from another host. */
export function externalLoadsInHtml(html: string): string[] {
  const loads: string[] = [];
  for (const match of html.matchAll(LOADING_SOURCES)) {
    const address = match[1] ?? '';
    if (isExternal(address)) loads.push(address);
  }
  for (const [tag] of html.matchAll(LINKS)) {
    const rel = /\srel\s*=\s*["']?([^"'>]+)/iu.exec(tag)?.[1]?.toLowerCase().split(/\s+/u) ?? [];
    const href = /\shref\s*=\s*["']?([^"'\s>]+)/iu.exec(tag)?.[1] ?? '';
    if (rel.some((one) => LOADING_RELS.has(one)) && isExternal(href)) loads.push(href);
  }
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)) {
    loads.push(...externalLoadsInCss(style[1] ?? ''));
  }
  return loads;
}

/**
 * The guide's pages the site lacks: each Markdown page of docs/guide needs its
 * built page and a link to it in the guide's sidebar, as the built page shows.
 */
export function missingGuidePages(
  pages: readonly string[],
  built: ReadonlySet<string>,
  sidebarPage: string,
  base: string,
): string[] {
  return pages.flatMap((page) => {
    const name = page.replace(/\.md$/u, '');
    const problems: string[] = [];
    if (!built.has(`guide/${name}.html`)) problems.push(`${page}: not built`);
    if (!sidebarPage.includes(`href="${base}guide/${name}.html"`)) {
      problems.push(`${page}: not in the guide's sidebar`);
    }
    return problems;
  });
}
