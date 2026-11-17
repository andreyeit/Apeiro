import { copyFileSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'tsdown';

/**
 * One package, four entries. The workspace packages (`@apeiro/*`, TypeScript sources) are
 * bundled in; shared code goes into common chunks, so `apeiro`, `apeiro/react`,
 * `apeiro/yjs` and `apeiro/yjs/react` see the same classes. react and yjs stay peer dependencies.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    react: 'src/react.ts',
    yjs: 'src/yjs.ts',
    'yjs-react': 'src/yjs-react.ts',
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
    // Next.js App Router: the React entries are client modules.
    banner: (chunk) =>
      chunk.isEntry && (chunk.name === 'react' || chunk.name === 'yjs-react')
        ? "'use client';"
        : '',
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
