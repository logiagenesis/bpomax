// @ts-check
/** The demo's templates routes (D-043), split out of demo.js (ARB-531). */
import { validateTemplateChange, validateVariantChange, variantWordsLocked } from '@arbitron/core';
import { logEvent, templateView, templatesOf } from '../shared.js';
import { uuid } from '../store.js';
/** @typedef {import('../store.js').Row} Row */

/**
 * @param {import('../context.js').Context} ctx
 * @returns {Response | undefined}
 */
export function templateRoutes(ctx) {
  const { method, body, store, path, key, respond, refused, templateProblems } = ctx;
  // ARB-340 in the demo: templates and their variants, held to the API's rules.
  if (key === 'GET /v1/templates') {
    return respond(200, { templates: templatesOf(store).map((t) => templateView(store, t)) });
  }
  if (key === 'POST /v1/templates') {
    const checked = validateTemplateChange(body, { partial: false });
    if (!checked.ok) return refused(checked.errors);
    const problems = templateProblems(checked.value, null);
    if (problems.length > 0) return refused(problems);
    const now = new Date().toISOString();
    const row = {
      id: uuid(),
      name: checked.value.name,
      categorySlug: checked.value.categorySlug ?? null,
      description: checked.value.description ?? null,
      active: checked.value.active ?? true,
      variants: [],
      createdAt: now,
      updatedAt: now,
    };
    templatesOf(store).unshift(row);
    logEvent(store, 'template.created', {
      subject_table: 'templates',
      subject_id: row.id,
      payload: { via: 'web', name: row.name, category_slug: row.categorySlug },
    });
    return respond(201, { template: templateView(store, row) });
  }
  if (method === 'PATCH' && /^\/v1\/templates\/[^/]+$/.test(path)) {
    const row = templatesOf(store).find((x) => x.id === path.split('/')[3]);
    if (!row) return respond(404, { error: 'no such template' });
    const checked = validateTemplateChange(body, { partial: true });
    if (!checked.ok) return refused(checked.errors);
    const problems = templateProblems(checked.value, row);
    if (problems.length > 0) return refused(problems);
    Object.assign(row, checked.value, { updatedAt: new Date().toISOString() });
    logEvent(store, 'template.updated', { subject_table: 'templates', subject_id: row.id });
    return respond(200, { template: templateView(store, row) });
  }
  if (method === 'POST' && /^\/v1\/templates\/[^/]+\/variants$/.test(path)) {
    const row = templatesOf(store).find((x) => x.id === path.split('/')[3]);
    if (!row) return respond(404, { error: 'no such template' });
    const checked = validateVariantChange(body, { partial: false });
    if (!checked.ok) return refused(checked.errors);
    if (row.variants.some((/** @type {Row} */ v) => v.label === checked.value.label))
      return refused([{ field: 'label', message: 'is already used in this template' }]);
    const now = new Date().toISOString();
    const v = {
      id: uuid(),
      label: checked.value.label,
      body: checked.value.body,
      active: checked.value.active ?? true,
      createdAt: now,
      updatedAt: now,
    };
    row.variants.push(v);
    logEvent(store, 'template.variant_created', {
      subject_table: 'template_variants',
      subject_id: v.id,
      payload: { via: 'web', template_id: row.id, label: v.label },
    });
    return respond(201, { template: templateView(store, row) });
  }
  if (method === 'PATCH' && /^\/v1\/template-variants\/[^/]+$/.test(path)) {
    const id = path.split('/')[3];
    const row = templatesOf(store).find((x) =>
      x.variants.some((/** @type {Row} */ v) => v.id === id),
    );
    const v = row?.variants.find((/** @type {Row} */ x) => x.id === id);
    if (!row || !v) return respond(404, { error: 'no such variant' });
    const checked = validateVariantChange(body, { partial: true });
    if (!checked.ok) return refused(checked.errors);
    if (checked.value.body !== undefined && checked.value.body !== v.body) {
      const sent =
        templateView(store, row).variants.find((/** @type {Row} */ x) => x.id === id)?.sends ?? 0;
      const locked = variantWordsLocked(sent);
      if (locked) return respond(409, { error: locked });
    }
    if (
      checked.value.label !== undefined &&
      row.variants.some((/** @type {Row} */ x) => x !== v && x.label === checked.value.label)
    )
      return refused([{ field: 'label', message: 'is already used in this template' }]);
    Object.assign(v, checked.value, { updatedAt: new Date().toISOString() });
    logEvent(store, 'template.variant_updated', {
      subject_table: 'template_variants',
      subject_id: v.id,
      payload: { via: 'web', template_id: row.id },
    });
    return respond(200, { template: templateView(store, row) });
  }
  return undefined;
}
