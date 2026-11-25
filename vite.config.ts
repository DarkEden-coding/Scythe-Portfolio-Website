import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// The cube homepage plus a static write-up page per featured project.
export default defineConfig({
  build: {
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        eagleeye: resolve(import.meta.dirname, 'projects/eagleeye/index.html'),
        aerie: resolve(import.meta.dirname, 'projects/aerie/index.html'),
      },
    },
  },
});
