// @ts-check
import {
  MAX_TEMPLATE_DESCRIPTION,
  MAX_TEMPLATE_NAME,
  MAX_VARIANT_BODY,
  MAX_VARIANT_LABEL,
  canWrite,
  validateTemplateChange,
  validateVariantChange,
} from '@arbitron/core';
import { ApiError, apiGet, apiSend } from './lib/api.js';
import { formatRatio } from './lib/format.js';
import { clearFieldErrors, showFieldErrors } from './lib/forms.js';
import { backToLoginOn401, mountShell } from './lib/shell.js';
import { runAction } from './lib/ui.js';

/**
 * Templates and their A/B variants (ARB-340, docs/01 section I). `GET /v1/templates`
 * gives each variant's sends, replies and rate as the API counted them from the stored
 * rows; the page only formats them (`formatRatio`). Creating and changing go through
 * `POST /v1/templates`, `PATCH /v1/templates/:id`, `POST /v1/templates/:id/variants`
 * and `PATCH /v1/template-variants/:id`, each checked here first with the validator the
 * API runs. A variant's words are locked once it has been sent (D-064); the API says why.
 */

/**
 * @typedef {{ numerator: number, denominator: number, percent: string | null }} Ratio
 * @typedef {object} Variant
 * @property {string} id
 * @property {string} label
 * @property {string} body
 * @property {boolean} active
 * @property {number} sends
 * @property {number} replies
 * @property {Ratio} replyRate
 * @property {string | null} wordsLocked
 * @typedef {object} Template
 * @property {string} id
 * @property {string} name
 * @property {string | null} categorySlug
 * @property {string | null} categoryName
 * @property {string | null} description
 * @property {boolean} active
 * @property {Variant[]} variants
 * @property {number} sends
 * @property {number} replies
 * @property {Ratio} replyRate
 */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`templates is missing #${id}`);
  return element;
}

const refreshButton = /** @type {HTMLButtonElement} */ (byId('refresh'));
const status = byId('status');
const newForm = /** @type {HTMLFormElement} */ (byId('new-template'));
const newName = /** @type {HTMLInputElement} */ (byId('new-name'));
const newCategory = /** @type {HTMLSelectElement} */ (byId('new-categorySlug'));
const newDescription = /** @type {HTMLTextAreaElement} */ (byId('new-description'));
const createButton = /** @type {HTMLButtonElement} */ (byId('create'));
const list = byId('templates');
const empty = byId('empty');
const count = byId('count');

const ROLE_REASON = 'Your role can view templates but not change them.';
const CHECK_FIELDS = 'Some fields need attention. The first one has been selected.';

/** @type {Template[]} */
let templates = [];
/** @type {{ slug: string, name: string }[]} */
let categories = [];
let mayWrite = false;

newName.maxLength = MAX_TEMPLATE_NAME;
newDescription.maxLength = MAX_TEMPLATE_DESCRIPTION;

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, string>} [attributes]
 * @param {string} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
function el(tag, attributes = {}, text) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (text !== undefined) element.textContent = text;
  return element;
}

/** @param {HTMLButtonElement} button */
function guard(button) {
  if (mayWrite) return button;
  button.disabled = true;
  button.title = ROLE_REASON;
  return button;
}

/**
 * A labelled field with its error slot, ids from `prefix` so `showFieldErrors` finds it.
 * @param {string} prefix
 * @param {string} name
 * @param {string} label
 * @param {HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement} control
 * @param {string} [hint]
 */
function field(prefix, name, label, control, hint) {
  const wrap = el('div', { class: 'field' });
  control.id = `${prefix}${name}`;
  control.name = name;
  const described = [`${prefix}${name}-error`];
  const labelEl = el('label', { class: 'field__label', for: control.id }, label);
  wrap.append(labelEl, control);
  if (hint) {
    wrap.append(el('p', { class: 'field__hint', id: `${prefix}${name}-hint` }, hint));
    described.unshift(`${prefix}${name}-hint`);
  }
  control.setAttribute('aria-describedby', described.join(' '));
  const error = el('p', { class: 'field__error', id: `${prefix}${name}-error` });
  error.hidden = true;
  wrap.append(error);
  return wrap;
}

/** @param {string | null} selected */
function categorySelect(selected) {
  const select = el('select', { class: 'select' });
  select.append(el('option', { value: '' }, 'General (any category)'));
  for (const c of categories) select.append(el('option', { value: c.slug }, c.name));
  select.value = selected ?? '';
  return select;
}

/** @param {number} n */
const bids = (n) => `${String(n)} bid${n === 1 ? '' : 's'}`;

/**
 * Sends a change, shows the API's field errors on `form`, and on success puts the
 * template it returns in place of the old one.
 * @param {HTMLButtonElement} button
 * @param {HTMLElement | null} form
 * @param {string} prefix
 * @param {'POST' | 'PATCH'} method
 * @param {string} path
 * @param {unknown} body
 * @param {(t: Template) => string} success
 */
async function send(button, form, prefix, method, path, body, success) {
  if (form) clearFieldErrors(form);
  const result = await runAction(
    button,
    status,
    async () => {
      try {
        return /** @type {{ template: Template }} */ (await apiSend(method, path, body));
      } catch (error) {
        if (backToLoginOn401(error)) return undefined;
        if (form && error instanceof ApiError && error.errors.length > 0) {
          showFieldErrors(form, error.errors, prefix);
          throw new Error(CHECK_FIELDS);
        }
        throw error;
      }
    },
    { success: (r) => (r ? success(r.template) : '') },
  );
  if (!result) return false;
  const at = templates.findIndex((t) => t.id === result.template.id);
  if (at === -1) templates.unshift(result.template);
  else templates[at] = result.template;
  render();
  return true;
}

/**
 * @param {HTMLElement} form
 * @param {readonly { field: string, message: string }[]} errors
 * @param {string} prefix
 */
function refuseHere(form, errors, prefix) {
  showFieldErrors(form, errors, prefix);
  status.className = 'alert alert--error';
  status.textContent = CHECK_FIELDS;
}

/** @param {Template} t */
function templateEditForm(t) {
  const prefix = `t-${t.id}-`;
  const form = el('form', { class: 'stack', novalidate: '', id: `${prefix}edit` });
  form.hidden = true;
  const name = el('input', { class: 'input' });
  name.value = t.name;
  name.maxLength = MAX_TEMPLATE_NAME;
  const description = el('textarea', { class: 'textarea', rows: '2' });
  description.value = t.description ?? '';
  description.maxLength = MAX_TEMPLATE_DESCRIPTION;
  const category = categorySelect(t.categorySlug);
  const save = el('button', { type: 'submit', class: 'btn btn--primary' }, 'Save the template');
  const cancel = el('button', { type: 'button', class: 'btn btn--secondary' }, 'Cancel');
  const actions = el('div', { class: 'row-actions' });
  actions.append(save, cancel);
  form.append(
    field(prefix, 'name', 'Name', name),
    field(prefix, 'categorySlug', 'Category', category),
    field(prefix, 'description', 'Description (optional)', description),
    actions,
  );
  cancel.addEventListener('click', () => {
    form.hidden = true;
    document.getElementById(`${prefix}open-edit`)?.focus();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const body = {
      name: name.value,
      categorySlug: category.value,
      description: description.value,
    };
    const checked = validateTemplateChange(body, { partial: true });
    if (!checked.ok) return refuseHere(form, checked.errors, prefix);
    void send(
      save,
      form,
      prefix,
      'PATCH',
      `/v1/templates/${t.id}`,
      body,
      (x) => `Saved “${x.name}”.`,
    );
  });
  return form;
}

/**
 * @param {Template} t
 * @param {Variant} v
 */
function variantRow(t, v) {
  const tr = el('tr');
  tr.dataset.id = v.id;
  const head = el('th', { scope: 'row' });
  head.append(el('strong', {}, v.label));
  head.append(el('div', { class: 'field__hint' }, v.body));
  const rate = el('td', { class: 'num' }, formatRatio(v.replyRate));
  const sends = el('td', { class: 'num' }, String(v.sends));
  const replies = el('td', { class: 'num' }, String(v.replies));
  const state = el('td');
  state.append(
    el(
      'span',
      { class: `badge ${v.active ? 'badge--go' : 'badge--neutral'}` },
      v.active ? 'On' : 'Off',
    ),
  );
  const actions = el('td');
  const row = el('div', { class: 'row-actions' });
  const edit = guard(
    el('button', {
      type: 'button',
      class: 'btn btn--secondary',
      id: `v-${v.id}-open-edit`,
      'aria-label': `Edit variant ${v.label}`,
    }),
  );
  edit.textContent = 'Edit';
  const toggle = guard(
    el('button', {
      type: 'button',
      class: 'btn btn--secondary',
      id: `v-${v.id}-toggle`,
      'aria-label': `${v.active ? 'Switch off' : 'Switch on'} variant ${v.label}`,
    }),
  );
  toggle.textContent = v.active ? 'Switch off' : 'Switch on';
  row.append(edit, toggle);
  actions.append(row);
  tr.append(head, rate, sends, replies, state, actions);

  edit.addEventListener('click', () => openVariantEdit(t, v));
  toggle.addEventListener('click', () => {
    void send(
      toggle,
      null,
      '',
      'PATCH',
      `/v1/template-variants/${v.id}`,
      { active: !v.active },
      () =>
        v.active
          ? `Switched off variant ${v.label}; bids are drafted from the other switched-on variants.`
          : `Switched on variant ${v.label}; it takes its turn with the others.`,
    );
  });
  return tr;
}

/**
 * @param {Template} t
 * @param {Variant} v
 */
function openVariantEdit(t, v) {
  const prefix = `t-${t.id}-variant-`;
  const form = /** @type {HTMLFormElement} */ (byId(`${prefix}form`));
  clearFieldErrors(form);
  form.hidden = false;
  form.dataset.variant = v.id;
  byId(`${prefix}heading`).textContent = `Edit variant ${v.label}`;
  const label = /** @type {HTMLInputElement} */ (byId(`${prefix}label`));
  const body = /** @type {HTMLTextAreaElement} */ (byId(`${prefix}body`));
  const lock = byId(`${prefix}body-hint`);
  label.value = v.label;
  body.value = v.body;
  body.disabled = v.wordsLocked !== null;
  lock.textContent = v.wordsLocked ?? 'The words the model starts a bid from.';
  label.focus();
}

/** @param {Template} t */
function variantEditForm(t) {
  const prefix = `t-${t.id}-variant-`;
  const form = el('form', { class: 'stack', novalidate: '', id: `${prefix}form` });
  form.hidden = true;
  const heading = el('h3', { id: `${prefix}heading` }, 'Edit variant');
  form.setAttribute('aria-labelledby', heading.id);
  const label = el('input', { class: 'input' });
  label.maxLength = MAX_VARIANT_LABEL;
  const body = el('textarea', { class: 'textarea', rows: '6' });
  body.maxLength = MAX_VARIANT_BODY;
  const save = el('button', { type: 'submit', class: 'btn btn--primary' }, 'Save the variant');
  const cancel = el('button', { type: 'button', class: 'btn btn--secondary' }, 'Cancel');
  const actions = el('div', { class: 'row-actions' });
  actions.append(save, cancel);
  form.append(
    heading,
    field(prefix, 'label', 'Label', label),
    field(prefix, 'body', 'Words', body, ' '),
    actions,
  );
  cancel.addEventListener('click', () => {
    const id = form.dataset.variant;
    form.hidden = true;
    if (id) document.getElementById(`v-${id}-open-edit`)?.focus();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const id = form.dataset.variant;
    const before = t.variants.find((v) => v.id === id);
    if (!before) return;
    /** @type {Record<string, string>} */
    const change = { label: label.value };
    if (!body.disabled && body.value.trim() !== before.body) change.body = body.value;
    const checked = validateVariantChange(change, { partial: true });
    if (!checked.ok) return refuseHere(form, checked.errors, prefix);
    void send(
      save,
      form,
      prefix,
      'PATCH',
      `/v1/template-variants/${before.id}`,
      change,
      () => `Saved variant ${checked.value.label ?? before.label}.`,
    );
  });
  return form;
}

/** @param {Template} t */
function addVariantForm(t) {
  const prefix = `t-${t.id}-new-`;
  const form = el('form', { class: 'stack', novalidate: '', id: `${prefix}form` });
  const heading = el('h3', { id: `${prefix}heading` }, 'Add a variant');
  form.setAttribute('aria-labelledby', heading.id);
  const label = el('input', { class: 'input' });
  label.maxLength = MAX_VARIANT_LABEL;
  const body = el('textarea', { class: 'textarea', rows: '4' });
  body.maxLength = MAX_VARIANT_BODY;
  const add = guard(el('button', { type: 'submit', class: 'btn btn--primary' }, 'Add the variant'));
  const actions = el('div', { class: 'row-actions' });
  actions.append(add);
  for (const control of [label, body]) {
    control.disabled = !mayWrite;
  }
  form.append(
    heading,
    field(prefix, 'label', 'Label', label, 'Such as A, B or “Short opening”.'),
    field(prefix, 'body', 'Words', body),
    actions,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const change = { label: label.value, body: body.value };
    const checked = validateVariantChange(change, { partial: false });
    if (!checked.ok) return refuseHere(form, checked.errors, prefix);
    void send(
      add,
      form,
      prefix,
      'POST',
      `/v1/templates/${t.id}/variants`,
      change,
      (x) => `Added variant ${checked.value.label ?? ''} to “${x.name}”.`,
    );
  });
  return form;
}

/** @param {Template} t */
function templateCard(t) {
  const prefix = `t-${t.id}-`;
  const card = el('section', { class: 'card stack', 'aria-labelledby': `${prefix}title` });
  card.dataset.id = t.id;
  const title = el('div', { class: 'cluster' });
  title.append(
    el('h2', { id: `${prefix}title` }, t.name),
    el(
      'span',
      { class: `badge ${t.active ? 'badge--go' : 'badge--neutral'}` },
      t.active ? 'On' : 'Switched off',
    ),
  );
  const about = el(
    'p',
    { class: 'field__hint' },
    [t.categoryName ?? 'General: for a job whose category has no template', t.description]
      .filter(Boolean)
      .join(' · '),
  );
  const figures = el('p', { id: `${prefix}figures` });
  figures.append(
    el('strong', {}, 'Reply rate: '),
    `${formatRatio(t.replyRate)}, from ${bids(t.sends)} sent.`,
  );
  const live = t.variants.filter((v) => v.active).length;
  const note = el(
    'p',
    { class: 'section-note' },
    live === 0
      ? 'No variant is switched on, so no bid is drafted from this template.'
      : live === 1
        ? 'One variant is switched on. Add a second to compare two versions.'
        : `${String(live)} variants are switched on and take turns.`,
  );

  const buttons = el('div', { class: 'row-actions' });
  const edit = guard(
    el(
      'button',
      { type: 'button', class: 'btn btn--secondary', id: `${prefix}open-edit` },
      'Edit the template',
    ),
  );
  const toggle = guard(
    el(
      'button',
      { type: 'button', class: 'btn btn--secondary', id: `${prefix}toggle` },
      t.active ? 'Switch the template off' : 'Switch the template on',
    ),
  );
  buttons.append(edit, toggle);
  const editForm = templateEditForm(t);
  edit.addEventListener('click', () => {
    editForm.hidden = false;
    /** @type {HTMLInputElement | null} */ (editForm.querySelector('input'))?.focus();
  });
  toggle.addEventListener('click', () => {
    void send(toggle, null, '', 'PATCH', `/v1/templates/${t.id}`, { active: !t.active }, (x) =>
      x.active
        ? `Switched on “${x.name}”; bids are drafted from it again.`
        : `Switched off “${x.name}”; no bid is drafted from it.`,
    );
  });

  const table = el('table', { class: 'table' });
  const caption = el('caption', { class: 'visually-hidden' }, `Variants of ${t.name}`);
  const thead = el('thead');
  const headRow = el('tr');
  for (const [text, numeric] of /** @type {[string, boolean][]} */ ([
    ['Variant', false],
    ['Reply rate', true],
    ['Sent', true],
    ['Replies', true],
    ['State', false],
    ['Actions', false],
  ])) {
    headRow.append(el('th', { scope: 'col', ...(numeric ? { class: 'num' } : {}) }, text));
  }
  thead.append(headRow);
  const tbody = el('tbody');
  for (const v of t.variants) tbody.append(variantRow(t, v));
  table.append(caption, thead, tbody);
  const wrap = el('div', { class: 'table-wrap' });
  wrap.append(table);

  card.append(title, about, figures, note, buttons, editForm);
  if (t.variants.length > 0) card.append(wrap, variantEditForm(t));
  else card.append(el('p', {}, 'No variants yet: add the first below.'));
  card.append(addVariantForm(t));
  return card;
}

function render() {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.id : '';
  list.replaceChildren(...templates.map(templateCard));
  empty.hidden = templates.length > 0;
  const variants = templates.reduce((n, t) => n + t.variants.length, 0);
  count.textContent =
    templates.length === 0
      ? ''
      : `${String(templates.length)} template${templates.length === 1 ? '' : 's'}, ${String(variants)} variant${variants === 1 ? '' : 's'}.`;
  if (focused) document.getElementById(focused)?.focus();
}

async function fetchList() {
  const body = /** @type {{ templates: Template[] }} */ (await apiGet('/v1/templates'));
  templates = body.templates;
  render();
  return templates;
}

/** @param {HTMLButtonElement} button */
async function fetchAndRender(button) {
  await runAction(
    button,
    status,
    async () => {
      try {
        return await fetchList();
      } catch (error) {
        if (backToLoginOn401(error)) return undefined;
        throw error;
      }
    },
    {
      success: (list) =>
        !list
          ? ''
          : list.length === 0
            ? 'No templates yet.'
            : `Showing ${String(list.length)} template${list.length === 1 ? '' : 's'}.`,
    },
  );
}

newForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const body = {
    name: newName.value,
    categorySlug: newCategory.value,
    description: newDescription.value,
  };
  const checked = validateTemplateChange(body, { partial: false });
  if (!checked.ok) return refuseHere(newForm, checked.errors, 'new-');
  void send(createButton, newForm, 'new-', 'POST', '/v1/templates', body, (t) => {
    newForm.reset();
    return `Created “${t.name}”. Add its first variant below.`;
  });
});
refreshButton.addEventListener('click', () => void fetchAndRender(refreshButton));

void mountShell().then(async (me) => {
  if (!me) return;
  mayWrite = canWrite(me.role);
  for (const control of [newName, newCategory, newDescription]) control.disabled = !mayWrite;
  guard(createButton);
  try {
    const body = /** @type {{ categories: { slug: string, name: string }[] }} */ (
      await apiGet('/v1/service-categories')
    );
    categories = body.categories;
    for (const c of categories) newCategory.append(el('option', { value: c.slug }, c.name));
  } catch (error) {
    if (backToLoginOn401(error)) return;
  }
  void fetchAndRender(refreshButton);
});
