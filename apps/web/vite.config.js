import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

// Static multi-page build: every page is its own HTML file (01 section I).
// Pages are registered here as they are built (ARB-061).
export default defineConfig(({ mode }) => {
  // The browser build reads three of docs/01 section J's own names — SUPABASE_URL,
  // SUPABASE_ANON_KEY and API_URL — from the repository's .env (or .env.<mode>, or the
  // host's environment, which wins), rather than a second VITE_-prefixed set that
  // could drift from the first. They are the public browser values; nothing else in
  // .env is exposed. The e2e build (`--mode e2e`) reads the stand-ins in /.env.e2e.
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const env = { ...loadEnv(mode, repoRoot, ''), ...process.env };
  // Demo mode (D-043): only `--mode demo` puts the in-browser stand-in (src/demo/demo.js)
  // ahead of each page's own script. Every other build leaves it out entirely, so a real
  // deployment cannot fall back to sample data.
  const demo = mode === 'demo';
  return {
    root: 'src',
    plugins: demo
      ? [
          {
            name: 'arbitron-demo',
            // 'pre', so Vite then bundles the injected script like the page's own.
            transformIndexHtml: {
              order: 'pre',
              handler: (html) =>
                html.replace(
                  '<head>',
                  '<head>\n    <script type="module" src="./demo/demo.js"></script>',
                ),
            },
          },
        ]
      : [],
    envPrefix: 'ARBITRON_NONE_',
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(env.SUPABASE_URL ?? ''),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(env.SUPABASE_ANON_KEY ?? ''),
      'import.meta.env.VITE_API_URL': JSON.stringify(env.API_URL ?? ''),
    },
    build: {
      outDir: '../dist',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: 'src/index.html',
          login: 'src/login.html',
          dashboard: 'src/dashboard.html',
          feed: 'src/feed.html',
          approvals: 'src/approvals.html',
          conversations: 'src/conversations.html',
          suppliers: 'src/suppliers.html',
          sourcing: 'src/sourcing.html',
          pipeline: 'src/pipeline.html',
          templates: 'src/templates.html',
          analytics: 'src/analytics.html',
          settings: 'src/settings.html',
          'style-guide': 'src/style-guide.html',
          'audit-log': 'src/audit-log.html',
          privacy: 'src/privacy.html',
          'freelancer-callback': 'src/freelancer-callback.html',
        },
      },
    },
    server: { port: 5173 },
  };
});
