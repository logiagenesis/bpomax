import { defineConfig } from 'vite';

// Static multi-page build: every page is its own HTML file (01 section I).
// Pages are registered here as they are built (ARB-061).
export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: 'src/index.html',
        'style-guide': 'src/style-guide.html',
        'audit-log': 'src/audit-log.html',
      },
    },
  },
  server: { port: 5173 },
});
