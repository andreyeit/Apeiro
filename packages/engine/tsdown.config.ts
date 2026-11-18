import { copyFileSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'tsdown';

/**
 * One package, three entries. The workspace packages (`@apeiro/*`, TypeScript sources) are
 * bundled in; shared code goes into common chunks, so `apeiro`, `apeiro/react` and
 * `apeiro/sync` see the same classes. react and yjs stay peer dependencies.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    react: 'src/react.ts',
    sync: 'src/sync.ts',
  },
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: [
      /^react($|\/)/,
      /^react-dom($|\/)/,
      /^yjs($|\/)/,
      /^y-protocols($|\/)/,
      '@mapbox/tiny-sdf',
    ],
    alwaysBundle: [/^@apeiro\//],
  },
  outputOptions: {
    chunkFileNames: 'chunks/[name]-[hash].js',
    // Next.js App Router: the React entry is a client module.
    banner: (chunk) => (chunk.isEntry && chunk.name === 'react' ? "'use client';" : ''),
  },
  hooks: {
    'build:done': () => {
      mkdirSync('dist', { recursive: true });
      copyFileSync('../editor/src/styles.css', 'dist/styles.css');
      // npm shows the package's own README: it is the repository's one, copied here.
      copyFileSync('../../README.md', 'README.md');
    },
  },
});
