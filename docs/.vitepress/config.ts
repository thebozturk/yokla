// The documentation site (ADR-0098): VitePress builds docs/ as it is. The
// guide, the design and the ADRs keep reading on GitHub; here a link that
// leaves docs/ points to the file on GitHub, a Mermaid block becomes a
// diagram the site's own Mermaid draws, and nothing loads from another host.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type DefaultTheme } from 'vitepress';

const REPOSITORY = 'https://github.com/thebozturk/yokla';
const DOCS = dirname(dirname(fileURLToPath(import.meta.url)));

/** The guide's pages, in the order of its README; scripts/site/check.ts holds every page to it. */
export const GUIDE: readonly DefaultTheme.SidebarItem[] = [
  { text: 'A first run', link: '/guide/README' },
  { text: 'The analyzer', link: '/guide/analyzer' },
  { text: 'From a finding to its fix', link: '/guide/debugging' },
  { text: 'yokla in CI', link: '/guide/ci' },
  { text: 'Red teaming', link: '/guide/redteam' },
  { text: 'The profile', link: '/guide/profile' },
  { text: 'Cases', link: '/guide/cases' },
  { text: 'Checks', link: '/guide/checks' },
  { text: 'The model proxy', link: '/guide/model-proxy' },
  { text: 'Commands and configuration', link: '/guide/cli' },
  { text: 'yokla from code', link: '/guide/api' },
  { text: 'yokla with other tools', link: '/guide/interop' },
];

/** Every ADR, by its number and its title's first line. */
function decisions(): DefaultTheme.SidebarItem[] {
  return readdirSync(join(DOCS, 'adr'))
    .filter((file) => /^\d{4}-.*\.md$/u.test(file))
    .toSorted()
    .map((file) => {
      const heading = readFileSync(join(DOCS, 'adr', file), 'utf8').split('\n', 1)[0] ?? file;
      return { text: heading.replace(/^#\s*/u, ''), link: `/adr/${file.replace(/\.md$/u, '')}` };
    });
}

/**
 * A relative link from a page that leaves docs/, as the file's address on
 * GitHub; undefined for a link that stays, or isn't relative.
 */
export function outsideLink(page: string, href: string): string | undefined {
  // Another site, or a path of this one; an anchor resolves inside docs/.
  if (/^[a-z]+:|^\//iu.test(href)) return undefined;
  const target = posix.normalize(posix.join('docs', posix.dirname(page), href));
  if (target.startsWith('docs/')) return undefined;
  return `${REPOSITORY}/blob/main/${target}`;
}

export default defineConfig({
  title: 'yokla',
  description: 'Test conversational AI assistants end to end.',
  lang: 'en',
  base: '/yokla/',
  // The pages keep their file names, as their links on GitHub do.
  cleanUrls: false,
  lastUpdated: false,
  markdown: {
    // docs/ holds no HTML of its own: a placeholder such as <file> is text, as on GitHub.
    html: false,
    config(md) {
      // yokla's placeholders, such as {{env.NAME}}, are text in code, not Vue's.
      md.renderer.rules.code_inline = (tokens, index, _options, _env, self) => {
        const token = tokens[index];
        if (token === undefined) return '';
        return `<code v-pre${self.renderAttrs(token)}>${md.utils.escapeHtml(token.content)}</code>`;
      };
      const fence = md.renderer.rules.fence;
      md.renderer.rules.fence = (tokens, index, options, env, self) => {
        const token = tokens[index];
        if (token?.info.trim() === 'mermaid') {
          // Drawn in the browser by the site's own Mermaid (theme/index.ts).
          return `<pre class="mermaid" v-pre>${md.utils.escapeHtml(token.content)}</pre>\n`;
        }
        return fence === undefined ? '' : fence(tokens, index, options, env, self);
      };
      md.core.ruler.after('inline', 'yokla-outside-links', (state) => {
        const env: unknown = state.env;
        const page =
          typeof env === 'object' && env !== null && 'relativePath' in env
            ? String(env.relativePath)
            : '';
        for (const block of state.tokens) {
          for (const token of block.children ?? []) {
            const href = token.type === 'link_open' ? token.attrGet('href') : null;
            const outside = href === null ? undefined : outsideLink(page, href);
            if (outside !== undefined) token.attrSet('href', outside);
          }
        }
      });
    },
  },
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/README' },
      { text: 'Design', link: '/design' },
      { text: 'Decisions', link: '/adr/README' },
      { text: 'Changelog', link: `${REPOSITORY}/blob/main/CHANGELOG.md` },
    ],
    sidebar: {
      '/guide/': [{ text: 'Guide', items: [...GUIDE] }],
      '/adr/': [
        { text: 'Decisions', items: [{ text: 'All decisions', link: '/adr/README' }] },
        { text: 'Records', collapsed: false, items: decisions() },
      ],
    },
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: REPOSITORY }],
    outline: { level: [2, 3] },
    footer: { message: 'Apache-2.0' },
  },
});
