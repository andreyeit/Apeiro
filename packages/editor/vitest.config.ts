import { defineProject } from 'vitest/config';

export default defineProject({
  // One DOM per worker instead of one per file (setting it up was most of the run time).
  test: { name: 'editor', environment: 'happy-dom', isolate: false },
});
