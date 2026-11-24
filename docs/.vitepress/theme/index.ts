// The site's theme (ADR-0098): VitePress's own, and the Mermaid blocks drawn
// in the browser by the Mermaid the site serves, never one from a CDN.

import { onContentUpdated, type Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';

/** Draws the page's Mermaid blocks that aren't drawn yet. */
async function drawDiagrams(): Promise<void> {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
  await mermaid.run({ querySelector: 'pre.mermaid:not([data-processed])' });
}

const theme: Theme = {
  extends: DefaultTheme,
  setup() {
    onContentUpdated(() => {
      void drawDiagrams();
    });
  },
};

export default theme;
