import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    outDir: resolve(__dirname, 'dist'),
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/renderer/index.html'),
        tablet: resolve(__dirname, 'src/renderer/tablet.html')
      }
    },
    emptyOutDir: true,
    target: ['es2019', 'chrome79', 'safari13'],
    chunkSizeWarningLimit: 2000
  }
});
