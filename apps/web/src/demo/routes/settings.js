// @ts-check
/** The demo's settings routes (D-043), split out of demo.js (ARB-531). */
import {
  checkAutoSendGuardrails,
  parseFeeTable,
  validateAutoReply,
  validateMarginRules,
  validatePlanRecord,
  validateScanner,
} from '@arbitron/core';
import { blockersOf, logEvent } from '../shared.js';
import { ORG, USER, uuid } from '../store.js';
/** @typedef {import('../store.js').Row} Row */

/**
 * @param {import('../context.js').Context} ctx
 * @returns {Response | undefined}
 */
export function settingsRoutes(ctx) {
  const { method, body, store, path, key, idIn, respond } = ctx;
  // ARB-121 in the demo: the auto-reply is kept in the tab; nothing is ever sent.
  if (key === 'GET /v1/auto-reply') return respond(200, { autoReply: store.autoReply ?? null });
  if (key === 'PUT /v1/auto-reply') {
    const value = /** @type {Record<string, any>} */ (body ?? {});
    const validated = validateAutoReply(value);
    if (!validated.ok)
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    store.autoReply = {
      id: 'd0d0d0d0-0000-4000-8000-000000000026',
      ...validated.value,
      approvedBy: USER,
      updatedAt: new Date().toISOString(),
    };
    logEvent(store, 'settings.changed', {
      subject_table: 'auto_replies',
      subject_id: store.autoReply.id,
      payload: { via: 'web', changed: ['autoReply'] },
    });
    return respond(200, { autoReply: store.autoReply });
  }

  if (key === 'GET /v1/settings') {
    return respond(200, {
      settings: store.settings,
      liveModeBlockers: blockersOf(store.settings),
      environmentLiveMode: false,
      accounts: store.accounts,
      telegramLinked: store.telegramLinked,
      role: 'owner',
      freelancer: { configured: true, environment: 'demo', reason: null },
      upwork: { configured: true, environment: 'demo', reason: null },
    });
  }
  // ARB-020 in the demo: "connecting" goes straight to the callback page with a sample
  // code, and nothing reaches Freelancer.com.
  if (key === 'POST /v1/platform-accounts/freelancer/connect') {
    store.connectPending = true;
    logEvent(store, 'account.connect_started', { payload: { via: 'web', note: 'demo' } });
    return respond(201, {
      authorizeUrl: './freelancer-callback.html?code=demo-code',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
  }
  if (key === 'POST /v1/platform-accounts/freelancer/callback') {
    if (!store.connectPending) {
      return respond(409, {
        error:
          'No connection is waiting for this code, or it is more than ten minutes old. Start again from Settings.',
      });
    }
    store.connectPending = false;
    let account = store.accounts.find((a) => a.platform === 'freelancer');
    if (!account) {
      account = { id: uuid(), platform: 'freelancer', scopes: [], lastSyncAt: null };
      store.accounts.push(account);
    }
    Object.assign(account, {
      externalUserId: 'sample-account',
      externalUsername: 'sample-account (demo)',
      status: 'connected',
      scopes: ['basic', '1', '2', '5', '6'],
    });
    logEvent(store, 'account.connected', {
      subject_table: 'platform_accounts',
      subject_id: account.id,
      payload: { via: 'web', note: 'demo: nothing reached Freelancer.com' },
    });
    return respond(201, { account });
  }
  // ARB-300 in the demo: the same for Upwork, which is used to read jobs only.
  if (key === 'POST /v1/platform-accounts/upwork/connect') {
    store.upworkConnectPending = true;
    logEvent(store, 'account.connect_started', {
      payload: { via: 'web', platform: 'upwork', note: 'demo' },
    });
    return respond(201, {
      authorizeUrl: './upwork-callback.html?code=demo-code',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
  }
  if (key === 'POST /v1/platform-accounts/upwork/callback') {
    if (!store.upworkConnectPending) {
      return respond(409, {
        error:
          'No connection is waiting for this code, or it is more than ten minutes old. Start again from Settings.',
      });
    }
    store.upworkConnectPending = false;
    let account = store.accounts.find((a) => a.platform === 'upwork');
    if (!account) {
      account = { id: uuid(), platform: 'upwork', scopes: [], lastSyncAt: null };
      store.accounts.push(account);
    }
    Object.assign(account, {
      externalUserId: 'sample-upwork-account',
      externalUsername: 'Sample Upwork account (demo)',
      status: 'connected',
    });
    logEvent(store, 'account.connected', {
      subject_table: 'platform_accounts',
      subject_id: account.id,
      payload: { via: 'web', platform: 'upwork', note: 'demo: nothing reached Upwork' },
    });
    return respond(201, { account });
  }
  if (method === 'POST' && /^\/v1\/platform-accounts\/[^/]+\/disconnect$/.test(path)) {
    const account = store.accounts.find((a) => a.id === idIn('/v1/platform-accounts/'));
    if (!account) return respond(404, { error: 'no such platform account' });
    account.status = 'disconnected';
    logEvent(store, 'account.disconnected', {
      subject_table: 'platform_accounts',
      subject_id: account.id,
    });
    return respond(200, { account });
  }
  if (key === 'PATCH /v1/settings') {
    const validated = validateMarginRules(body);
    if (!validated.ok) {
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    }
    if (body.feeTable !== undefined) {
      const fees = parseFeeTable(body.feeTable);
      if (!fees.ok) {
        return respond(422, { error: 'the request was not accepted', errors: fees.errors });
      }
      store.settings.feeTable = body.feeTable;
    }
    const fixed = (/** @type {unknown} */ v) =>
      v === null || v === undefined ? null : Number(v).toFixed(3);
    const value = /** @type {Record<string, unknown>} */ (validated.value);
    if ('minMarginPct' in value) store.settings.minMarginPct = fixed(value.minMarginPct);
    if ('minMarginZarMinor' in value)
      store.settings.minMarginZarMinor =
        value.minMarginZarMinor === null ? null : String(value.minMarginZarMinor);
    if ('fxBufferPct' in value) store.settings.fxBufferPct = fixed(value.fxBufferPct);
    if ('vatPct' in value) store.settings.vatPct = fixed(value.vatPct);
    if ('retentionDays' in value) store.settings.retentionDays = value.retentionDays;
    store.settings.updatedAt = new Date().toISOString();
    logEvent(store, 'settings.changed', {
      subject_table: 'settings',
      payload: { via: 'web', changed: Object.keys(value) },
    });
    return respond(200, { settings: store.settings, liveModeBlockers: blockersOf(store.settings) });
  }
  if (key === 'POST /v1/settings/live-mode') {
    const live = body?.live;
    if (typeof live !== 'boolean') {
      return respond(422, {
        error: 'the request was not accepted',
        errors: [{ field: 'live', message: 'must be true or false' }],
      });
    }
    const missing = blockersOf(store.settings);
    if (live && missing.length > 0) {
      return respond(422, {
        error: `Live mode needs ${missing.join(', ')} before it can be switched on.`,
      });
    }
    store.settings.liveMode = live;
    logEvent(store, 'live_mode.changed', {
      subject_table: 'settings',
      payload: { via: 'web', live_after: live, note: 'demo: nothing is sent' },
    });
    return respond(200, { settings: store.settings, liveModeBlockers: missing });
  }
  if (method === 'PATCH' && /^\/v1\/platform-accounts\/[^/]+$/.test(path)) {
    const validated = validatePlanRecord(body);
    if (!validated.ok) {
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    }
    const account = store.accounts.find((a) => a.id === idIn('/v1/platform-accounts/'));
    if (!account) return respond(404, { error: 'no such platform account' });
    account.planName = validated.value.planName;
    account.monthlyBidAllowance = validated.value.monthlyBidAllowance;
    account.planRecordedOn = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
    logEvent(store, 'settings.changed', {
      subject_table: 'platform_accounts',
      subject_id: account.id,
      payload: { via: 'web', what: 'plan_recorded' },
    });
    return respond(200, { account });
  }
  if (key === 'GET /v1/price-bands') return respond(200, { categories: 22, bands: [] });

  if (key === 'GET /v1/scanners') return respond(200, { scanners: store.scanners });
  if ((key === 'POST /v1/scanners' || method === 'PATCH') && path.startsWith('/v1/scanners')) {
    const validated = validateScanner(body);
    const errors = validated.ok ? checkAutoSendGuardrails(body) : validated.errors;
    if (errors.length > 0) {
      return respond(422, { error: 'the request was not accepted', errors });
    }
    const fields = {
      name: String(body.name).trim(),
      platform: body.platform,
      filters: body.filters ?? {},
      poll_interval_seconds: body.pollIntervalSeconds ?? 120,
      active: body.active ?? true,
      auto_send: body.autoSend ?? false,
      min_score: body.minScore ?? null,
      daily_cap: body.dailyCap ?? 0,
      updated_at: new Date().toISOString(),
    };
    const editing =
      method === 'PATCH' ? store.scanners.find((s) => s.id === idIn('/v1/scanners/')) : null;
    const clash = store.scanners.find(
      (s) => s.name.toLowerCase() === fields.name.toLowerCase() && s.id !== editing?.id,
    );
    if (clash)
      return respond(409, { error: 'a scanner with that name already exists in this org' });
    if (method === 'PATCH') {
      if (!editing) return respond(404, { error: 'no such scanner' });
      Object.assign(editing, fields);
      logEvent(store, 'scanner.updated', { subject_table: 'scanners', subject_id: editing.id });
      return respond(200, { scanner: editing });
    }
    const row = { id: uuid(), org_id: ORG, created_at: new Date().toISOString(), ...fields };
    store.scanners.push(row);
    logEvent(store, 'scanner.created', {
      subject_table: 'scanners',
      subject_id: row.id,
      payload: { via: 'web', name: row.name },
    });
    return respond(201, { scanner: row });
  }
  if (method === 'DELETE' && path.startsWith('/v1/scanners/')) {
    const index = store.scanners.findIndex((s) => s.id === idIn('/v1/scanners/'));
    if (index < 0) return respond(404, { error: 'no such scanner' });
    const gone = /** @type {Row} */ (store.scanners.splice(index, 1)[0]);
    logEvent(store, 'scanner.deleted', { subject_table: 'scanners', subject_id: gone.id });
    return respond(204, null);
  }
  return undefined;
}
