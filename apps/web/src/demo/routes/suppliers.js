// @ts-check
/** The demo's suppliers routes (D-043), split out of demo.js (ARB-531). */
import { supplierCsvTemplate, suppliersToCsv, validateSupplierCsv } from '@arbitron/core';
import { DEMO_CATEGORIES, categoryName, csvFile, logEvent } from '../shared.js';
import { uuid } from '../store.js';
/** @typedef {import('../store.js').Row} Row */

/**
 * @param {import('../context.js').Context} ctx
 * @returns {Response | undefined}
 */
export function supplierRoutes(ctx) {
  const { body, store, key, respond, suppliers } = ctx;
  // ARB-200 in the demo: the supplier database, the template, the export and the import,
  // checked by the same rule the API runs. Nothing here is a real rate.
  if (key === 'GET /v1/suppliers') return respond(200, { suppliers });
  if (key === 'GET /v1/suppliers/template.csv') {
    return csvFile(supplierCsvTemplate(), 'suppliers-template.csv', null);
  }
  if (key === 'GET /v1/suppliers.csv') {
    const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return csvFile(
      suppliersToCsv(/** @type {any} */ (suppliers)),
      `suppliers-${stamp}.csv`,
      suppliers.length,
    );
  }
  if (key === 'POST /v1/suppliers/import') {
    if (typeof body?.csv !== 'string') {
      return respond(422, {
        error: 'the request was not accepted',
        errors: [{ field: 'csv', message: 'must be the file as text' }],
      });
    }
    const checked = validateSupplierCsv(body.csv, { categories: new Set(DEMO_CATEGORIES) });
    if (!checked.ok) {
      const lines = new Set(checked.errors.map((e) => e.line)).size;
      return respond(422, {
        error: `${String(lines)} line${lines === 1 ? ' has' : 's have'} problems; nothing was imported.`,
        errors: checked.errors,
      });
    }
    const rateCards = checked.value.reduce((n, s) => n + s.rateCards.length, 0);
    if (body.dryRun === true) {
      return respond(200, {
        ok: true,
        dryRun: true,
        lines: checked.lines,
        suppliers: checked.value.length,
        rateCards,
        created: 0,
        updated: 0,
      });
    }
    let created = 0;
    let updated = 0;
    const now = new Date().toISOString();
    for (const s of checked.value) {
      let row = suppliers.find((r) => r.name.toLowerCase() === s.name.toLowerCase());
      if (row) updated += 1;
      else {
        row = { id: uuid(), rateCards: [], createdAt: now };
        suppliers.push(row);
        created += 1;
      }
      Object.assign(row, {
        name: s.name,
        countryCode: s.countryCode,
        timeZone: s.timeZone,
        channel: s.channel,
        languages: s.languages,
        qualityScore: s.qualityScore,
        onTimeRate: s.onTimeRate,
        paysAfterDelivery: s.paysAfterDelivery,
        externalProfileUrl: s.externalProfileUrl,
        notes: s.notes,
        active: s.active,
        updatedAt: now,
      });
      for (const card of s.rateCards) {
        const existing = row.rateCards.find(
          (/** @type {Row} */ c) =>
            c.categorySlug === card.categorySlug && c.currency === card.currency,
        );
        const fields = {
          categorySlug: card.categorySlug,
          categoryName: categoryName(card.categorySlug),
          currency: card.currency,
          fixedPriceMinor: card.fixedPriceMinor,
          hourlyRateMinor: card.hourlyRateMinor,
          turnaroundDays: card.turnaroundDays,
        };
        if (existing) Object.assign(existing, fields);
        else row.rateCards.push({ id: uuid(), ...fields });
      }
    }
    suppliers.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    store.suppliers = suppliers;
    logEvent(store, 'supplier.imported', {
      subject_table: 'suppliers',
      payload: {
        via: 'web',
        lines: checked.lines,
        suppliers: checked.value.length,
        rate_cards: rateCards,
        created,
        updated,
      },
    });
    return respond(200, {
      ok: true,
      dryRun: false,
      lines: checked.lines,
      suppliers: checked.value.length,
      rateCards,
      created,
      updated,
    });
  }
  return undefined;
}
