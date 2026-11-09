import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// One Vitest project per workspace package (ADR-0006), plus the repo scripts.
const groups = ['packages', 'packs', 'examples'];
const packageDirs = groups.flatMap((group) =>
  readdirSync(group, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(group, entry.name, 'package.json')))
    .map((entry) => `${group}/${entry.name}`),
);

export default defineConfig({
  // Workspace packages resolve to their TypeScript sources through the
  // `@yokla/source` export condition, so tests never need a build.
  ssr: {
    resolve: {
      conditions: ['@yokla/source', 'module', 'node', 'development|production'],
    },
  },
  test: {
    projects: [
      ...packageDirs.map((dir) => ({
        extends: true,
        test: { name: dir, root: dir, include: ['src/**/*.test.ts'] },
      })),
      {
        extends: true,
        test: { name: 'scripts', root: 'scripts', include: ['**/*.test.ts'] },
      },
    ],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'packs/*/src/**', 'examples/*/src/**', 'scripts/**'],
      exclude: ['**/*.test.ts'],
    },
  },
});
