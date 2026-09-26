// @ts-check
/**
 * Demo mode (D-043). Only a demo build contains this file: `vite build --mode demo`
 * injects it ahead of every page's own script (apps/web/vite.config.js), and every other
 * build leaves it out, so a real deployment can never fall back to it (D-036).
 *
 * It stands in for the two services a page talks to, inside the browser:
 * - Supabase Auth: any email and password signs in, as a sample person.
 * - The Arbitron API: every route the pages call, answered in the shapes the real routes
 *   return (the same shapes the Playwright specs use), from sample data kept in this
 *   tab's sessionStorage. The rules a form is held to are `@arbitron/core`'s, the same
 *   ones the API runs, so the demo accepts and refuses what the real thing would.
 *
 * Nothing leaves the browser. Every page carries a banner saying so, and saying that the
 * figures are samples, not real prices, fees or clients.
 */
import { json } from './shared.js';
import { SESSION_KEY, STORE_KEY, USER, uuid } from './store.js';
import { makeContext } from './context.js';
import { accountRoutes } from './routes/account.js';
import { replyRoutes } from './routes/replies.js';
import { categoryRoutes } from './routes/categories.js';
import { sourcingRoutes } from './routes/sourcing.js';
import { pipelineRoutes } from './routes/pipeline.js';
import { paymentRoutes } from './routes/payments.js';
import { analyticsRoutes } from './routes/analytics.js';
import { postRoutes } from './routes/posts.js';
import { templateRoutes } from './routes/templates.js';
import { supplierRoutes } from './routes/suppliers.js';
import { threadRoutes } from './routes/threads.js';
import { proposalRoutes } from './routes/proposals.js';
import { settingsRoutes } from './routes/settings.js';
import { recordRoutes } from './routes/records.js';

const env = /** @type {Record<string, string | undefined>} */ (import.meta.env ?? {});
const API_ORIGIN = new URL(env.VITE_API_URL || 'https://demo-api.invalid').origin;
const AUTH_ORIGIN = new URL(env.VITE_SUPABASE_URL || 'https://demo.supabase.invalid').origin;
/** The route groups, in the order the single function once ran them (ARB-531). */
const ROUTES = [
  accountRoutes,
  replyRoutes,
  categoryRoutes,
  sourcingRoutes,
  pipelineRoutes,
  paymentRoutes,
  analyticsRoutes,
  postRoutes,
  templateRoutes,
  supplierRoutes,
  threadRoutes,
  proposalRoutes,
  settingsRoutes,
  recordRoutes,
];

/**
 * @param {string} method
 * @param {URL} url
 * @param {any} body
 */
function api(method, url, body) {
  const ctx = makeContext(method, url, body);
  for (const routes of ROUTES) {
    const answer = routes(ctx);
    if (answer) return answer;
  }
  return ctx.respond(404, { error: `the demo has no ${method} ${ctx.path}` });
}

/** Supabase Auth, as far as the pages use it: the password grant, the user, sign-out. */
/** @param {string} method @param {URL} url @param {any} body */
function auth(method, url, body) {
  if (method === 'POST' && url.pathname === '/auth/v1/token') {
    if (!body?.email || !body?.password) {
      return json(400, {
        code: 400,
        error_code: 'validation_failed',
        msg: 'missing email or password',
      });
    }
    return json(200, {
      access_token: 'demo-access-token',
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: 'demo-refresh-token',
      user: { id: USER, email: String(body.email) },
    });
  }
  // ARB-400: sign-up answers as a project that asks for email confirmation does — the
  // user, no session — so the demo never pretends an account was made.
  if (method === 'POST' && url.pathname === '/auth/v1/signup') {
    return json(200, {
      id: uuid(),
      aud: 'authenticated',
      email: String(body?.email ?? ''),
      email_confirmed_at: null,
    });
  }
  if (method === 'POST' && url.pathname === '/auth/v1/logout') return json(204, null);
  if (method === 'GET' && url.pathname === '/auth/v1/user') return json(200, { id: USER });
  return json(404, { msg: 'not in the demo' });
}

// ------------------------------------------------------------------ the patch
const realFetch = window.fetch.bind(window);

window.fetch = async (input, init = {}) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input), location.href);
  if (url.origin !== API_ORIGIN && url.origin !== AUTH_ORIGIN) return realFetch(input, init);
  const method = (init.method ?? request?.method ?? 'GET').toUpperCase();
  let body = null;
  const raw = init.body ?? null;
  if (typeof raw === 'string') {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  // A short pause, so loading states show as they would against a real server.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return url.origin === API_ORIGIN ? api(method, url, body) : auth(method, url, body);
};

// A signed-in page opened directly gets the sample person's session, so every page can
// be viewed from its own link. The login and sign-up pages are left alone so they can be
// seen too.
const page = location.pathname.split('/').pop() || 'index.html';
if (!['login.html', 'signup.html'].includes(page) && !sessionStorage.getItem(SESSION_KEY)) {
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      access_token: 'demo-access-token',
      refresh_token: 'demo-refresh-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: USER, email: 'demo@example.com' },
    }),
  );
}

// ------------------------------------------------------------------ the banner
function banner() {
  const style = document.createElement('style');
  style.textContent = `
    .demo-banner { background: var(--color-warning, #b58100); color: #111; padding: 8px 16px;
      font-size: 0.875rem; line-height: 1.5; text-align: center; }
    .demo-banner button { margin-left: 8px; font: inherit; text-decoration: underline;
      background: none; border: 0; color: inherit; cursor: pointer; padding: 0; }
  `;
  const note = document.createElement('div');
  note.className = 'demo-banner';
  note.setAttribute('role', 'note');
  note.id = 'demo-banner';
  note.append(
    'Demo mode: sample data only. Nothing is saved to a server or sent to a marketplace, and no figure is a real price, fee or client.',
  );
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.id = 'demo-reset';
  reset.textContent = 'Reset the sample data';
  reset.addEventListener('click', () => {
    sessionStorage.removeItem(STORE_KEY);
    location.reload();
  });
  note.append(reset);
  document.head.append(style);
  document.body.prepend(note);
}

if (document.body) banner();
else document.addEventListener('DOMContentLoaded', banner);
