// @ts-check
/** The demo's records routes (D-043), split out of demo.js (ARB-531). */
import { csvCell, filteredEvents, logEvent, me, sast } from '../shared.js';
import { ORG, USER, save } from '../store.js';

/**
 * @param {import('../context.js').Context} ctx
 * @returns {Response | undefined}
 */
export function recordRoutes(ctx) {
  const {
    method,
    url,
    body,
    store,
    path,
    key,
    idIn,
    respond,
    threads,
    inbound,
    discovery,
    briefs,
    threadMessages,
  } = ctx;
  // ARB-521 in the demo: the settings page's "Your data" section, over the sample data.
  if (key === 'GET /v1/privacy/me') {
    const data = {
      generatedAt: new Date().toISOString(),
      person: me(store).user,
      memberships: [{ org_id: ORG, org_name: me(store).org.name, role: 'owner' }],
      namedIn: {
        'events.actor_user_id': store.events.filter((e) => e.actor_user_id === USER),
      },
    };
    logEvent(store, 'privacy.exported', { payload: { kind: 'person' } });
    save(store);
    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="my-data-demo.json"',
      },
    });
  }
  if (method === 'GET' && path.startsWith('/v1/privacy/clients/')) {
    const handle = decodeURIComponent(idIn('/v1/privacy/clients/') ?? '').trim();
    const held = threads.filter(
      (t) => String(t.clientHandle ?? '').toLowerCase() === handle.toLowerCase(),
    );
    const data = {
      generatedAt: new Date().toISOString(),
      handle,
      threads: held,
      messages: held.flatMap((t) => threadMessages(t.id)),
      discoverySessions: discovery.filter((d) => held.some((t) => t.id === d.threadId)),
      briefs: briefs.filter((b) => held.some((t) => t.id === b.threadId)),
    };
    logEvent(store, 'privacy.exported', {
      payload: { kind: 'client', threads: held.length, messages: data.messages.length },
    });
    save(store);
    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="client-data-demo.json"',
      },
    });
  }
  if (method === 'POST' && /^\/v1\/privacy\/clients\/[^/]+\/erase$/.test(path)) {
    const handle = decodeURIComponent(idIn('/v1/privacy/clients/') ?? '').trim();
    if (
      String(body?.confirm ?? '')
        .trim()
        .toLowerCase() !== handle.toLowerCase()
    ) {
      return respond(422, {
        error: 'the request was not accepted',
        errors: [
          {
            field: 'confirm',
            message: "must be the client's handle again: erasure cannot be undone",
          },
        ],
      });
    }
    const held = threads.filter(
      (t) => String(t.clientHandle ?? '').toLowerCase() === handle.toLowerCase(),
    );
    let messages = 0;
    for (const t of held) {
      t.clientHandle = null;
      t.status = 'closed';
      for (const m of inbound.filter((x) => x.threadId === t.id)) {
        m.body = '[redacted: erased on request]';
        messages += 1;
      }
    }
    const sessions = discovery.filter((d) => held.some((t) => t.id === d.threadId));
    for (const d of sessions) d.answers = {};
    logEvent(store, 'privacy.erased', {
      outcome: held.length > 0 ? 'ok' : 'skipped',
      payload: { threads: held.length, messages, discovery_sessions: sessions.length },
    });
    return respond(200, {
      erased: { threads: held.length, messages, discoverySessions: sessions.length },
    });
  }

  if (key === 'POST /v1/telegram/link-codes') {
    const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
      'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.charAt(b % 32),
    ).join('');
    return respond(201, { code, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  }

  if (key === 'GET /v1/events/actors') {
    return respond(200, { actors: [{ id: USER, name: 'Demo Owner', email: 'demo@example.com' }] });
  }
  if (key === 'GET /v1/events.csv') {
    const rows = filteredEvents(store, url);
    const header =
      'date_sast,created_at_utc,type,outcome,actor_kind,actor_user_id,subject_table,subject_id,request_id,payload,id';
    const lines = rows.map((e) =>
      [
        sast(e.created_at),
        e.created_at,
        e.type,
        e.outcome,
        e.actor_kind,
        e.actor_user_id,
        e.subject_table,
        e.subject_id,
        e.request_id,
        JSON.stringify(e.payload),
        e.id,
      ]
        .map(csvCell)
        .join(','),
    );
    save(store);
    return new Response([header, ...lines].join('\r\n') + '\r\n', {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="audit-log-demo.csv"',
        'x-export-rows': String(rows.length),
        'x-export-truncated': 'false',
      },
    });
  }
  if (key === 'GET /v1/events') {
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    return respond(200, {
      events: filteredEvents(store, url).slice(offset, offset + limit),
      page: { limit, offset },
    });
  }
  return undefined;
}
