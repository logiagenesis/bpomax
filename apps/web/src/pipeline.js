// @ts-check
import {
  canWrite,
  minorToCsvAmount,
  parseAmountText,
  reconcileMilestones,
  sastDay,
  validateDeliveryOrderEdit,
  validatePaymentInput,
  validateRetainer,
} from '@arbitron/core';
import { ApiError, apiGet, apiSend } from './lib/api.js';
import { formatDate, formatDateTime, formatMoney } from './lib/format.js';
import { clearFieldErrors, showFieldErrors } from './lib/forms.js';
import { backToLoginOn401, mountShell } from './lib/shell.js';
import { confirmAction, runAction } from './lib/ui.js';

/**
 * The pipeline (docs/01 section I: "board by stage") and each job's delivery order
 * (ARB-310): `GET /v1/pipeline`, `PATCH /v1/pipeline-items/:id`, `GET/PATCH
 * /v1/delivery-orders/:id`, `POST …/status`, `PATCH …/handover/:key` and
 * `PATCH …/milestones/:index`. The milestones are checked on the page with the API's own
 * rule (`validateDeliveryOrderEdit`: they add up to the agreed cost to the cent), and
 * every move shows the API's reasons on its button before it is pressed. Payments
 * (ARB-311): `GET/POST /v1/pipeline-items/:id/payments`, checked on the page with the
 * API's rule (`validatePaymentInput`), with realised margin as the API works it.
 */

/**
 * @typedef {object} PipelineItem
 * @property {string} id
 * @property {string} jobId
 * @property {string} jobTitle
 * @property {string} platform
 * @property {string} stage
 * @property {string | null} valueMinor
 * @property {string | null} currency
 * @property {boolean} retainer
 * @property {string | null} retainerMonthlyMinor
 * @property {string} stageChangedAt
 * @property {string | null} deliveryOrderId
 * @property {string | null} deliveryStatus
 */

/**
 * @typedef {object} Milestone
 * @property {string} title
 * @property {number} amountMinor
 * @property {string | null} due
 * @property {'pending' | 'delivered' | 'accepted'} status
 */

/**
 * @typedef {object} Order
 * @property {string} id
 * @property {string} pipelineItemId
 * @property {string} status
 * @property {string} jobTitle
 * @property {string | null} briefTitle
 * @property {string} pipelineStage
 * @property {string | null} supplierName
 * @property {string | null} agreedCostMinor
 * @property {string | null} currency
 * @property {string | null} due
 * @property {Milestone[]} milestones
 * @property {string} milestonesTotalMinor
 * @property {boolean} reconciled
 * @property {{ key: string, text: string, done: boolean }[]} handover
 * @property {string | null} handedOverAt
 * @property {string | null} deliveredAt
 * @property {string | null} acceptedAt
 * @property {string | null} cancelledAt
 * @property {Record<string, string[]>} moves
 * @property {string} createdAt
 */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`pipeline is missing #${id}`);
  return element;
}

const refreshButton = /** @type {HTMLButtonElement} */ (byId('refresh'));
const status = byId('status');
const board = byId('board');
const empty = byId('empty');
const section = byId('delivery');
const title = byId('delivery-title');
const meta = byId('delivery-meta');
const deliveryStatus = byId('delivery-status');
const figures = byId('delivery-figures');
const milestoneRows = byId('milestone-rows');
const form = /** @type {HTMLFormElement} */ (byId('order-form'));
const costInput = /** @type {HTMLInputElement} */ (byId('order-agreedCostMinor'));
const currencyInput = /** @type {HTMLInputElement} */ (byId('order-currency'));
const dueInput = /** @type {HTMLInputElement} */ (byId('order-due'));
const milestoneFields = byId('order-milestones');
const totalLine = byId('order-total');
const addButton = /** @type {HTMLButtonElement} */ (byId('milestone-add'));
const saveButton = /** @type {HTMLButtonElement} */ (byId('order-save'));
const handoverList = byId('handover');
const movesBox = byId('moves');

const paymentsSection = byId('payments');
const paymentsTitle = byId('payments-title');
const paymentsMeta = byId('payments-meta');
const paymentsStatus = byId('payments-status');
const paymentsNotice = byId('payments-notice');
const marginFigures = byId('margin-figures');
const unconvertedList = byId('unconverted');
const paymentRows = byId('payment-rows');
const paymentsEmpty = byId('payments-empty');
const paymentForm = /** @type {HTMLFormElement} */ (byId('payment-form'));
const kindSelect = /** @type {HTMLSelectElement} */ (byId('payment-kind'));
const payAmount = /** @type {HTMLInputElement} */ (byId('payment-amountMinor'));
const payCurrency = /** @type {HTMLInputElement} */ (byId('payment-currency'));
const payPaidOn = /** @type {HTMLInputElement} */ (byId('payment-paidOn'));
const payRate = /** @type {HTMLInputElement} */ (byId('payment-fxRate'));
const payOrder = /** @type {HTMLSelectElement} */ (byId('payment-deliveryOrderId'));
const payMilestone = /** @type {HTMLSelectElement} */ (byId('payment-milestoneIndex'));
const payReference = /** @type {HTMLInputElement} */ (byId('payment-reference'));
const paySave = /** @type {HTMLButtonElement} */ (byId('payment-save'));

const ROLE_REASON = 'Your role can view the pipeline but not change it.';

const KIND_WORDS = /** @type {Record<string, string>} */ ({
  client: 'Client payment',
  supplier: 'Supplier payment',
  platform_fee: 'Platform fee',
  other_cost: 'Other cost',
});

/**
 * @typedef {object} PaymentsView
 * @property {{ id: string, jobTitle: string, stage: string, valueMinor: string | null, currency: string | null }} item
 * @property {{ id: string, status: string, currency: string | null, supplierName: string | null, supplierCountry: string | null, milestones: { title: string, amountMinor: number, status: string }[] }[]} orders
 * @property {{ id: string, kind: string, direction: string, amountMinor: string, currency: string, fxRateUsed: string | null, fxRateAt: string | null, amountZarMinor: string | null, paidAt: string, reference: string | null, deliveryOrderId: string | null, milestoneIndex: number | null, recordedByName: string | null }[]} payments
 * @property {{ inZarMinor: string, supplierZarMinor: string, feesZarMinor: string, otherZarMinor: string, marginZarMinor: string, unconverted: { kind: string, amountMinor: string, currency: string }[] }} margin
 * @property {boolean} paidInFull
 */

/** @type {PaymentsView | null} */
let paymentsView = null;

const STAGE_WORDS = /** @type {Record<string, string>} */ ({
  applied: 'Applied',
  replied: 'Replied',
  discovery: 'Discovery',
  briefed: 'Briefed',
  sourcing: 'Sourcing',
  won: 'Won',
  in_delivery: 'In delivery',
  delivered: 'Delivered',
  paid: 'Paid',
  lost: 'Lost',
});

const ORDER_WORDS = /** @type {Record<string, string>} */ ({
  draft: 'Draft',
  assigned: 'Assigned',
  in_progress: 'In progress',
  delivered: 'Delivered',
  accepted: 'Accepted',
  cancelled: 'Cancelled',
});

const MOVE_LABELS = /** @type {Record<string, string>} */ ({
  assigned: 'Assign the supplier',
  in_progress: 'Start the work',
  delivered: 'Mark the order delivered',
  accepted: 'Mark the order accepted',
  cancelled: 'Cancel the order',
});

const MOVE_DONE = /** @type {Record<string, string>} */ ({
  assigned: 'Assigned the supplier.',
  in_progress: 'The supplier has started. The job is in delivery.',
  delivered: 'The order is delivered. The job is marked delivered.',
  accepted: 'The order is accepted.',
  cancelled: 'Cancelled the order. The sourcing request is open again for another supplier.',
});

const MILESTONE_WORDS = /** @type {Record<string, string>} */ ({
  pending: 'Pending',
  delivered: 'Delivered',
  accepted: 'Accepted',
});

let mayWrite = false;
/** @type {Order | null} */
let current = null;
/** @type {string[]} */
let stages = [];

/** DD/MM/YYYY typed on the page as an ISO day, or null when it is not a real date. */
function isoDay(/** @type {string} */ text) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
    return null;
  return `${String(y)}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** An ISO day as DD/MM/YYYY. */
function dayText(/** @type {string | null} */ iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d ?? ''}/${m ?? ''}/${y ?? ''}`;
}

/**
 * @param {HTMLButtonElement} button
 * @param {string} reason empty when the button is usable
 */
function gate(button, reason) {
  button.disabled = reason !== '';
  if (reason) button.title = reason;
  else button.removeAttribute('title');
}

/** @param {PipelineItem} item */
function itemCard(item) {
  const article = document.createElement('article');
  article.className = 'card stack';
  article.dataset.id = item.id;
  const heading = document.createElement('h3');
  heading.textContent = item.jobTitle;
  const facts = document.createElement('p');
  facts.className = 'field__hint';
  facts.textContent = [
    item.valueMinor && item.currency
      ? formatMoney(BigInt(item.valueMinor), item.currency)
      : 'No value recorded',
    item.retainer && item.retainerMonthlyMinor && item.currency
      ? `retainer ${formatMoney(BigInt(item.retainerMonthlyMinor), item.currency)} a month`
      : null,
    `since ${formatDate(item.stageChangedAt)}`,
    item.deliveryStatus
      ? `delivery ${ORDER_WORDS[item.deliveryStatus]?.toLowerCase() ?? item.deliveryStatus}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const controls = document.createElement('div');
  controls.className = 'cluster';
  const selectId = `stage-${item.id}`;
  const label = document.createElement('label');
  label.className = 'field__label';
  label.htmlFor = selectId;
  label.textContent = `Stage for ${item.jobTitle}`;
  const select = document.createElement('select');
  select.className = 'select';
  select.id = selectId;
  for (const stage of stages) {
    const option = document.createElement('option');
    option.value = stage;
    option.textContent = STAGE_WORDS[stage] ?? stage;
    option.selected = stage === item.stage;
    select.append(option);
  }
  const moveButton = document.createElement('button');
  moveButton.type = 'button';
  moveButton.className = 'btn btn--secondary';
  moveButton.textContent = 'Move';
  moveButton.setAttribute('aria-label', `Move ${item.jobTitle} to the chosen stage`);
  if (!mayWrite) {
    select.disabled = true;
    gate(moveButton, ROLE_REASON);
  }
  moveButton.addEventListener('click', () => void moveItem(moveButton, item, select.value));
  controls.append(label, select, moveButton);
  const payments = document.createElement('button');
  payments.type = 'button';
  payments.className = 'btn btn--secondary';
  payments.textContent = 'Payments';
  payments.setAttribute('aria-label', `Open the payments for ${item.jobTitle}`);
  payments.addEventListener('click', () => void openPayments(payments, item.id));
  controls.append(payments);
  if (item.deliveryOrderId) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn--primary';
    open.textContent = 'Open delivery';
    open.setAttribute('aria-label', `Open the delivery order for ${item.jobTitle}`);
    const orderId = item.deliveryOrderId;
    open.addEventListener('click', () => void openOrder(open, orderId));
    controls.append(open);
  }
  article.append(heading, facts, controls, retainerControls(item));
  return article;
}

/**
 * The retainer toggle (ARB-312): a checkbox, the monthly amount, and the currency when the
 * job has none recorded. Checked with `validateRetainer`, the API's rule.
 * @param {PipelineItem} item
 */
function retainerControls(item) {
  const form = document.createElement('form');
  form.className = 'cluster';
  form.noValidate = true;
  const prefix = `retainer-${item.id}-`;
  const check = document.createElement('label');
  check.className = 'check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = `${prefix}retainer`;
  box.checked = item.retainer;
  check.append(box, ` Retainer for ${item.jobTitle}`);
  const amountWrap = document.createElement('div');
  amountWrap.className = 'field';
  const amountLabel = document.createElement('label');
  amountLabel.className = 'field__label';
  amountLabel.htmlFor = `${prefix}retainerMonthlyMinor`;
  amountLabel.textContent = `Monthly amount for ${item.jobTitle}`;
  const amount = document.createElement('input');
  amount.className = 'input';
  amount.id = `${prefix}retainerMonthlyMinor`;
  amount.inputMode = 'decimal';
  amount.value =
    item.retainerMonthlyMinor && item.currency
      ? minorToCsvAmount(item.retainerMonthlyMinor, item.currency)
      : '';
  amount.setAttribute('aria-describedby', `${prefix}retainerMonthlyMinor-error`);
  const amountError = document.createElement('p');
  amountError.className = 'field__error';
  amountError.id = `${prefix}retainerMonthlyMinor-error`;
  amountError.hidden = true;
  amountWrap.append(amountLabel, amount, amountError);
  /** @type {HTMLInputElement | null} */
  let currency = null;
  const parts = [check, amountWrap];
  if (!item.currency) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const label = document.createElement('label');
    label.className = 'field__label';
    label.htmlFor = `${prefix}currency`;
    label.textContent = `Currency for ${item.jobTitle}`;
    currency = document.createElement('input');
    currency.className = 'input';
    currency.id = `${prefix}currency`;
    currency.maxLength = 3;
    currency.setAttribute('aria-describedby', `${prefix}currency-error`);
    const error = document.createElement('p');
    error.className = 'field__error';
    error.id = `${prefix}currency-error`;
    error.hidden = true;
    wrap.append(label, currency, error);
    parts.push(wrap);
  }
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn--secondary';
  save.textContent = 'Save retainer';
  save.setAttribute('aria-label', `Save the retainer for ${item.jobTitle}`);
  if (!mayWrite) {
    box.disabled = true;
    amount.disabled = true;
    if (currency) currency.disabled = true;
    gate(save, ROLE_REASON);
  }
  form.append(...parts, save);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    const code = (currency?.value ?? item.currency ?? '').trim().toUpperCase();
    const minor = box.checked
      ? parseAmountText(amount.value, /^[A-Z]{3}$/.test(code) ? code : 'ZAR')
      : null;
    /** @type {{ field: string, message: string }[]} */
    const problems = [];
    if (box.checked && minor === null)
      problems.push({
        field: 'retainerMonthlyMinor',
        message: 'must be the monthly amount, such as 4500.00',
      });
    const payload = {
      retainer: box.checked,
      retainerMonthlyMinor: minor === null ? null : Number(minor),
      ...(currency ? { currency: code } : {}),
    };
    if (problems.length === 0) {
      const validated = validateRetainer(payload);
      if (!validated.ok) problems.push(...validated.errors);
      if (box.checked && currency && !/^[A-Z]{3}$/.test(code))
        problems.push({ field: 'currency', message: 'must be a three-letter currency code' });
    }
    if (problems.length > 0) {
      showFieldErrors(form, problems, prefix);
      status.className = 'alert alert--error';
      status.textContent = 'Some fields need attention. The first one has been selected.';
      return;
    }
    const done = await runAction(
      save,
      status,
      async () => {
        try {
          return await apiSend('PATCH', `/v1/pipeline-items/${item.id}`, payload);
        } catch (error) {
          if (backToLoginOn401(error)) return undefined;
          if (error instanceof ApiError && error.errors.length > 0) {
            showFieldErrors(form, error.errors, prefix);
            throw new Error('Some fields need attention. The first one has been selected.');
          }
          throw error;
        }
      },
      {
        success: box.checked
          ? `${item.jobTitle} is a retainer of ${formatMoney(BigInt(/** @type {string} */ (minor)), code)} a month.`
          : `${item.jobTitle} is no longer a retainer.`,
      },
    );
    if (done) {
      const text = status.textContent;
      await fetchBoard().catch(() => undefined);
      status.className = 'alert alert--success';
      status.textContent = text;
    }
  });
  return form;
}

/** @param {PipelineItem[]} items */
function renderBoard(items) {
  board.replaceChildren();
  for (const stage of stages) {
    const inStage = items.filter((item) => item.stage === stage);
    if (inStage.length === 0) continue;
    const column = document.createElement('section');
    column.className = 'stack';
    column.dataset.stage = stage;
    column.setAttribute('aria-labelledby', `stage-${stage}-heading`);
    const heading = document.createElement('h2');
    heading.id = `stage-${stage}-heading`;
    heading.textContent = `${STAGE_WORDS[stage] ?? stage} (${String(inStage.length)})`;
    column.append(heading, ...inStage.map(itemCard));
    board.append(column);
  }
  empty.hidden = items.length !== 0;
}

async function fetchBoard() {
  const body = /** @type {{ stages: string[], items: PipelineItem[] }} */ (
    await apiGet('/v1/pipeline')
  );
  stages = body.stages;
  renderBoard(body.items);
  return body.items.length;
}

/** @param {HTMLButtonElement} button */
async function load(button) {
  await runAction(
    button,
    status,
    async () => {
      try {
        return await fetchBoard();
      } catch (error) {
        if (backToLoginOn401(error)) return 0;
        throw error;
      }
    },
    {
      success: (n) =>
        n === 0
          ? 'No jobs in the pipeline yet.'
          : `Loaded ${String(n)} job${n === 1 ? '' : 's'} in the pipeline.`,
    },
  );
}

/**
 * @param {HTMLButtonElement} button
 * @param {PipelineItem} item
 * @param {string} stage
 */
async function moveItem(button, item, stage) {
  if (stage === item.stage) {
    status.className = 'alert alert--info';
    status.textContent = `${item.jobTitle} is already at ${STAGE_WORDS[stage] ?? stage}.`;
    return;
  }
  if (stage === 'lost') {
    const ok = await confirmAction({
      title: `Mark ${item.jobTitle} as lost?`,
      body: 'The job leaves the active pipeline. It can be moved back later.',
      confirmLabel: 'Mark as lost',
      danger: true,
    });
    if (!ok) return;
  }
  const done = await runAction(
    button,
    status,
    async () => {
      try {
        return await apiSend('PATCH', `/v1/pipeline-items/${item.id}`, { stage });
      } catch (error) {
        if (backToLoginOn401(error)) return undefined;
        throw error;
      }
    },
    { success: `Moved ${item.jobTitle} to ${STAGE_WORDS[stage] ?? stage}.` },
  );
  if (done) {
    const text = status.textContent;
    await fetchBoard().catch(() => undefined);
    status.className = 'alert alert--success';
    status.textContent = text;
  }
}

/**
 * @param {string} term
 * @param {string} value
 */
function figure(term, value) {
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = value;
  return [dt, dd];
}

/** @param {Order} o */
function money(o, /** @type {string | number | null} */ minor) {
  if (minor === null || !o.currency) return 'Not set';
  return formatMoney(BigInt(minor), o.currency);
}

/**
 * A milestone's editable row.
 * @param {number} index
 * @param {{ title: string, amount: string, due: string }} values
 */
function milestoneFieldset(index, values) {
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'grid';
  fieldset.dataset.index = String(index);
  const legend = document.createElement('legend');
  legend.textContent = `Milestone ${String(index + 1)}`;
  fieldset.append(legend);
  const make = (
    /** @type {string} */ key,
    /** @type {string} */ text,
    /** @type {string} */ value,
  ) => {
    const id = `order-milestones-${String(index)}--${key}`;
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const label = document.createElement('label');
    label.className = 'field__label';
    label.htmlFor = id;
    label.textContent = text;
    const input = document.createElement('input');
    input.className = 'input';
    input.id = id;
    input.name = key;
    input.value = value;
    if (key === 'amountMinor') input.inputMode = 'decimal';
    input.setAttribute('aria-describedby', `${id}-error`);
    input.addEventListener('input', showTotal);
    const error = document.createElement('p');
    error.className = 'field__error';
    error.id = `${id}-error`;
    error.hidden = true;
    wrap.append(label, input, error);
    return wrap;
  };
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn--secondary';
  remove.textContent = 'Remove';
  remove.setAttribute('aria-label', `Remove milestone ${String(index + 1)}`);
  remove.addEventListener('click', () => {
    const rows = readMilestoneInputs();
    rows.splice(index, 1);
    renderMilestoneFields(rows);
    showTotal();
  });
  fieldset.append(
    make('title', `Milestone ${String(index + 1)} title`, values.title),
    make('amountMinor', `Milestone ${String(index + 1)} amount`, values.amount),
    make('due', `Milestone ${String(index + 1)} due (DD/MM/YYYY)`, values.due),
    remove,
  );
  return fieldset;
}

/** @returns {{ title: string, amount: string, due: string }[]} */
function readMilestoneInputs() {
  return [...milestoneFields.querySelectorAll('fieldset')].map((fieldset) => {
    const value = (/** @type {string} */ name) =>
      /** @type {HTMLInputElement} */ (fieldset.querySelector(`input[name="${name}"]`)).value;
    return { title: value('title'), amount: value('amountMinor'), due: value('due') };
  });
}

/** @param {{ title: string, amount: string, due: string }[]} rows */
function renderMilestoneFields(rows) {
  milestoneFields.replaceChildren(...rows.map((row, i) => milestoneFieldset(i, row)));
  gate(addButton, rows.length >= 20 ? 'An order has at most 20 milestones.' : '');
}

/** The running total under the milestones, in the one money format. */
function showTotal() {
  const currency = currencyInput.value.trim().toUpperCase() || 'ZAR';
  const cost = parseAmountText(costInput.value, currency);
  const amounts = readMilestoneInputs().map((row) => parseAmountText(row.amount, currency));
  if (cost === null || amounts.some((a) => a === null) || !/^[A-Z]{3}$/.test(currency)) {
    totalLine.textContent = 'Type the agreed cost and every amount to see the total.';
    return;
  }
  const check = reconcileMilestones(
    amounts.map((a) => ({ amountMinor: Number(a) })),
    Number(cost),
    currency,
  );
  totalLine.textContent = check.ok
    ? `The milestones add up to the agreed cost: ${formatMoney(check.totalMinor, currency)}.`
    : check.message;
  totalLine.dataset.reconciled = String(check.ok);
}

/** @param {Order} o */
function renderOrder(o) {
  current = o;
  title.textContent = `Delivery for ${o.jobTitle}`;
  meta.textContent = [
    o.supplierName ? `Supplier ${o.supplierName}` : 'No supplier chosen',
    ORDER_WORDS[o.status] ?? o.status,
    `job ${STAGE_WORDS[o.pipelineStage]?.toLowerCase() ?? o.pipelineStage}`,
    o.briefTitle ? `brief ${o.briefTitle}` : null,
    `opened ${formatDateTime(o.createdAt)}`,
  ]
    .filter(Boolean)
    .join(' · ');
  section.dataset.status = o.status;

  figures.replaceChildren(
    ...figure('Agreed cost', money(o, o.agreedCostMinor)),
    ...figure('Milestones total', money(o, o.milestonesTotalMinor)),
    ...figure(
      'Reconciled',
      o.reconciled ? 'Yes: the milestones add up to the agreed cost.' : 'No: they differ.',
    ),
    ...figure('Due', o.due ? dayText(o.due) : 'No date agreed'),
  );
  if (o.handedOverAt) figures.append(...figure('Started', formatDateTime(o.handedOverAt)));
  if (o.deliveredAt) figures.append(...figure('Delivered', formatDateTime(o.deliveredAt)));
  if (o.acceptedAt) figures.append(...figure('Accepted', formatDateTime(o.acceptedAt)));
  if (o.cancelledAt) figures.append(...figure('Cancelled', formatDateTime(o.cancelledAt)));

  const working = ['in_progress', 'delivered'].includes(o.status);
  milestoneRows.replaceChildren(
    ...o.milestones.map((m, index) => {
      const tr = document.createElement('tr');
      tr.dataset.index = String(index);
      const cells = [m.title, money(o, m.amountMinor), m.due ? dayText(m.due) : 'No date'];
      for (const [i, text] of cells.entries()) {
        const td = document.createElement('td');
        if (i === 1) td.className = 'num';
        td.textContent = text;
        tr.append(td);
      }
      const state = document.createElement('td');
      state.textContent = MILESTONE_WORDS[m.status] ?? m.status;
      const action = document.createElement('td');
      if (m.status !== 'accepted') {
        const next = m.status === 'pending' ? 'delivered' : 'accepted';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn--secondary';
        button.textContent = next === 'delivered' ? 'Mark delivered' : 'Mark accepted';
        button.setAttribute('aria-label', `Mark ${m.title} ${next}`);
        gate(
          button,
          !mayWrite
            ? ROLE_REASON
            : working
              ? ''
              : 'A milestone is marked once the work has started and until the order is accepted.',
        );
        button.addEventListener('click', () => void markMilestone(button, o, index, next));
        action.append(button);
      }
      tr.append(state, action);
      return tr;
    }),
  );

  const editable = mayWrite && ['draft', 'assigned'].includes(o.status);
  form.hidden = !editable;
  if (editable) {
    clearFieldErrors(form);
    const currency = o.currency ?? 'ZAR';
    costInput.value =
      o.agreedCostMinor === null ? '' : minorToCsvAmount(o.agreedCostMinor, currency);
    currencyInput.value = o.currency ?? '';
    dueInput.value = dayText(o.due);
    renderMilestoneFields(
      o.milestones.map((m) => ({
        title: m.title,
        amount: minorToCsvAmount(String(m.amountMinor), currency),
        due: dayText(m.due),
      })),
    );
    showTotal();
  }

  const open = ['draft', 'assigned'].includes(o.status);
  handoverList.replaceChildren(
    ...o.handover.map((item) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'check';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = item.done;
      box.dataset.key = item.key;
      box.disabled = !mayWrite || !open;
      if (!mayWrite) box.title = ROLE_REASON;
      else if (!open) box.title = 'The handover is closed once the supplier has started.';
      box.addEventListener('change', () => void tick(box, o, item.key, box.checked));
      label.append(box, ` ${item.text}`);
      li.append(label);
      return li;
    }),
  );

  movesBox.replaceChildren(
    ...Object.entries(o.moves).map(([to, reasons]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = to === 'cancelled' ? 'btn btn--danger' : 'btn btn--primary';
      button.textContent = MOVE_LABELS[to] ?? to;
      button.dataset.move = to;
      gate(button, !mayWrite ? ROLE_REASON : reasons.join(' '));
      button.addEventListener('click', () => void moveOrder(button, o, to));
      return button;
    }),
  );
  if (Object.keys(o.moves).length === 0) {
    const done = document.createElement('p');
    done.className = 'field__hint';
    done.textContent =
      o.status === 'accepted'
        ? 'The order is accepted. Payments are recorded against it next.'
        : 'The order is cancelled.';
    movesBox.append(done);
  }
  section.hidden = false;
  const params = new URLSearchParams();
  params.set('order', o.id);
  history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
}

/** @param {string} id */
async function loadOrder(id) {
  const body = /** @type {{ order: Order }} */ (await apiGet(`/v1/delivery-orders/${id}`));
  renderOrder(body.order);
  return body.order;
}

/**
 * @param {HTMLButtonElement} button
 * @param {string} id
 */
async function openOrder(button, id) {
  await runAction(
    button,
    deliveryStatus,
    async () => {
      try {
        return await loadOrder(id);
      } catch (error) {
        if (backToLoginOn401(error)) return null;
        throw error;
      }
    },
    { success: (o) => (o ? `Opened the delivery order for ${o.jobTitle}.` : '') },
  );
  section.hidden = false;
  section.scrollIntoView({ block: 'start' });
}

/**
 * Sends a change and shows the order the API returns.
 * @param {HTMLButtonElement | HTMLInputElement} control
 * @param {() => Promise<unknown>} work
 * @param {string} success
 */
async function change(control, work, success) {
  const button = /** @type {HTMLButtonElement} */ (control);
  const result = /** @type {{ order: Order } | undefined} */ (
    await runAction(
      button,
      deliveryStatus,
      async () => {
        try {
          return await work();
        } catch (error) {
          if (backToLoginOn401(error)) return undefined;
          throw error;
        }
      },
      { success },
    )
  );
  if (result) {
    renderOrder(result.order);
    deliveryStatus.className = 'alert alert--success';
    deliveryStatus.textContent = success;
    await fetchBoard().catch(() => undefined);
  } else if (current) renderOrder(current);
  return result;
}

/**
 * @param {HTMLButtonElement} button
 * @param {Order} o
 * @param {string} to
 */
async function moveOrder(button, o, to) {
  if (to === 'cancelled') {
    const ok = await confirmAction({
      title: `Cancel the delivery order for ${o.jobTitle}?`,
      body: 'The order stops here and cannot be reopened. The sourcing request opens again so another supplier can be chosen.',
      confirmLabel: 'Cancel the order',
      danger: true,
    });
    if (!ok) return;
  }
  if (to === 'assigned') {
    const ok = await confirmAction({
      title: `Assign ${o.supplierName ?? 'the supplier'}?`,
      body: `The agreed cost of ${money(o, o.agreedCostMinor)} and its ${String(o.milestones.length)} milestone${o.milestones.length === 1 ? '' : 's'} are what the supplier is paid against. They can still change until the work starts.`,
      confirmLabel: 'Assign',
    });
    if (!ok) return;
  }
  await change(
    button,
    () => apiSend('POST', `/v1/delivery-orders/${o.id}/status`, { status: to }),
    MOVE_DONE[to] ?? 'Done.',
  );
}

/**
 * @param {HTMLInputElement} box
 * @param {Order} o
 * @param {string} key
 * @param {boolean} done
 */
async function tick(box, o, key, done) {
  await change(
    box,
    () =>
      apiSend('PATCH', `/v1/delivery-orders/${o.id}/handover/${encodeURIComponent(key)}`, { done }),
    done ? 'Ticked the handover item.' : 'Unticked the handover item.',
  );
}

/**
 * @param {HTMLButtonElement} button
 * @param {Order} o
 * @param {number} index
 * @param {string} to
 */
async function markMilestone(button, o, index, to) {
  const m = o.milestones[index];
  await change(
    button,
    () =>
      apiSend('PATCH', `/v1/delivery-orders/${o.id}/milestones/${String(index)}`, { status: to }),
    `Marked ${m?.title ?? 'the milestone'} ${to}.`,
  );
}

/** A figure in rand from the API's minor-unit text. */
const rand = (/** @type {string} */ minor) => formatMoney(BigInt(minor), 'ZAR');

/** Shows the supplier fields only for a supplier payment, and the milestones of the chosen order. */
function syncPaymentFields() {
  const supplier = kindSelect.value === 'supplier';
  for (const control of [payOrder, payMilestone]) {
    const wrap = control.closest('.field');
    if (wrap instanceof HTMLElement) wrap.hidden = !supplier;
  }
  const order = paymentsView?.orders.find((o) => o.id === payOrder.value);
  const kept = payMilestone.value;
  payMilestone.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'Not against one milestone';
  payMilestone.append(none);
  for (const [index, m] of (order?.milestones ?? []).entries()) {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${m.title} (${order?.currency ? formatMoney(BigInt(m.amountMinor), order.currency) : String(m.amountMinor)})`;
    payMilestone.append(option);
  }
  if ([...payMilestone.options].some((o) => o.value === kept)) payMilestone.value = kept;
  const rateWrap = payRate.closest('.field');
  if (rateWrap instanceof HTMLElement)
    rateWrap.hidden = payCurrency.value.trim().toUpperCase() === 'ZAR';
}

/** @param {PaymentsView} view */
function renderPayments(view) {
  paymentsView = view;
  const { item, margin } = view;
  paymentsTitle.textContent = `Payments for ${item.jobTitle}`;
  paymentsMeta.textContent = [
    item.valueMinor && item.currency
      ? `Value ${formatMoney(BigInt(item.valueMinor), item.currency)}`
      : 'No value recorded',
    `stage ${STAGE_WORDS[item.stage]?.toLowerCase() ?? item.stage}`,
    view.paidInFull ? 'paid in full' : 'not paid in full',
  ].join(' · ');
  marginFigures.replaceChildren(
    ...figure('Client payments (in)', rand(margin.inZarMinor)),
    ...figure('Supplier payments (out)', rand(margin.supplierZarMinor)),
    ...figure('Platform fees (out)', rand(margin.feesZarMinor)),
    ...figure('Other costs (out)', rand(margin.otherZarMinor)),
    ...figure('Realised margin', rand(margin.marginZarMinor)),
  );
  unconvertedList.replaceChildren(
    ...margin.unconverted.map((u) => {
      const li = document.createElement('li');
      li.textContent = `${KIND_WORDS[u.kind] ?? u.kind} of ${formatMoney(BigInt(u.amountMinor), u.currency)} has no rand figure and is left out of the margin.`;
      return li;
    }),
  );
  paymentRows.replaceChildren(
    ...view.payments.map((p) => {
      const tr = document.createElement('tr');
      const index = p.milestoneIndex;
      const milestone =
        p.kind === 'supplier' && index !== null
          ? (view.orders.find((o) => o.id === p.deliveryOrderId)?.milestones[index]?.title ?? null)
          : null;
      const cells = [
        formatDate(p.paidAt),
        `${KIND_WORDS[p.kind] ?? p.kind}${milestone ? ` · ${milestone}` : ''}`,
        formatMoney(BigInt(p.amountMinor), p.currency),
        p.fxRateUsed
          ? `${p.fxRateUsed.replace(/0+$/, '').replace(/\.$/, '').replace('.', ',')}${p.fxRateAt ? ` at ${formatDateTime(p.fxRateAt)}` : ''}`
          : p.currency === 'ZAR'
            ? '—'
            : 'No rate',
        p.amountZarMinor === null ? 'Not converted' : rand(p.amountZarMinor),
        p.reference ?? '',
      ];
      for (const [i, text] of cells.entries()) {
        const td = document.createElement('td');
        if (i === 2 || i === 4) td.className = 'num';
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    }),
  );
  paymentsEmpty.hidden = view.payments.length !== 0;

  payOrder.replaceChildren();
  for (const o of view.orders) {
    const option = document.createElement('option');
    option.value = o.id;
    option.textContent = `${o.supplierName ?? 'Supplier'} (${o.status.replace('_', ' ')})`;
    payOrder.append(option);
  }
  paymentForm.hidden = !mayWrite;
  if (!payCurrency.value) payCurrency.value = item.currency ?? 'ZAR';
  if (!payPaidOn.value) payPaidOn.value = dayText(sastDay(new Date()));
  syncPaymentFields();
  paymentsSection.hidden = false;
}

/** @param {string} itemId */
async function loadPayments(itemId) {
  const view = /** @type {PaymentsView} */ (await apiGet(`/v1/pipeline-items/${itemId}/payments`));
  renderPayments(view);
  return view;
}

/**
 * @param {HTMLButtonElement} button
 * @param {string} itemId
 */
async function openPayments(button, itemId) {
  paymentsNotice.hidden = true;
  payCurrency.value = '';
  payPaidOn.value = '';
  await runAction(
    button,
    paymentsStatus,
    async () => {
      try {
        return await loadPayments(itemId);
      } catch (error) {
        if (backToLoginOn401(error)) return null;
        throw error;
      }
    },
    { success: (v) => (v ? `Opened the payments for ${v.item.jobTitle}.` : '') },
  );
  paymentsSection.hidden = false;
  paymentsSection.scrollIntoView({ block: 'start' });
}

kindSelect.addEventListener('change', syncPaymentFields);
payOrder.addEventListener('change', () => {
  payMilestone.value = '';
  syncPaymentFields();
});
payCurrency.addEventListener('input', syncPaymentFields);

paymentForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!paymentsView) return;
  const view = paymentsView;
  clearFieldErrors(paymentForm);
  const currency = payCurrency.value.trim().toUpperCase();
  /** @type {{ field: string, message: string }[]} */
  const problems = [];
  const minor = parseAmountText(payAmount.value, /^[A-Z]{3}$/.test(currency) ? currency : 'ZAR');
  if (minor === null)
    problems.push({ field: 'amountMinor', message: 'must be an amount such as 7500.00' });
  const paidOn = isoDay(payPaidOn.value);
  if (!paidOn) problems.push({ field: 'paidOn', message: 'must be a real date as DD/MM/YYYY' });
  const kind = kindSelect.value;
  const payload = {
    kind,
    amountMinor: minor === null ? null : Number(minor),
    currency,
    paidOn: paidOn ?? '',
    fxRate: currency === 'ZAR' ? null : payRate.value.trim() || null,
    reference: payReference.value,
    deliveryOrderId: kind === 'supplier' ? payOrder.value || null : null,
    milestoneIndex:
      kind === 'supplier' && payMilestone.value !== '' ? Number(payMilestone.value) : null,
  };
  if (problems.length === 0) {
    const validated = validatePaymentInput(payload, { today: sastDay(new Date()) });
    if (!validated.ok) problems.push(...validated.errors);
  }
  if (problems.length > 0) {
    showFieldErrors(paymentForm, problems, 'payment-');
    paymentsStatus.className = 'alert alert--error';
    paymentsStatus.textContent = 'Some fields need attention. The first one has been selected.';
    return;
  }
  const amountText = formatMoney(BigInt(/** @type {number} */ (payload.amountMinor)), currency);
  const ok = await confirmAction({
    title: `Record ${amountText} ${kind === 'client' ? 'in' : 'out'}?`,
    body: `${KIND_WORDS[kind] ?? kind} for ${view.item.jobTitle}, paid on ${payPaidOn.value.trim()}. A recorded payment is kept in the audit log; it cannot be edited.`,
    confirmLabel: 'Record',
  });
  if (!ok) return;
  const result = /** @type {(PaymentsView & { notice: string | null }) | undefined} */ (
    await runAction(
      paySave,
      paymentsStatus,
      async () => {
        try {
          return await apiSend('POST', `/v1/pipeline-items/${view.item.id}/payments`, payload);
        } catch (error) {
          if (backToLoginOn401(error)) return undefined;
          // The API's field problems (a rate it needs, B-10) land on their fields.
          if (error instanceof ApiError && error.errors.length > 0) {
            showFieldErrors(paymentForm, error.errors, 'payment-');
            throw new Error('Some fields need attention. The first one has been selected.');
          }
          throw error;
        }
      },
      {
        success: `Recorded the ${(KIND_WORDS[kind] ?? kind).toLowerCase()} of ${amountText}.`,
      },
    )
  );
  if (result) {
    const text = paymentsStatus.textContent;
    payAmount.value = '';
    payRate.value = '';
    payReference.value = '';
    renderPayments(result);
    paymentsNotice.hidden = !result.notice;
    paymentsNotice.textContent = result.notice ?? '';
    paymentsStatus.className = 'alert alert--success';
    paymentsStatus.textContent = text;
    await fetchBoard().catch(() => undefined);
  }
});

addButton.addEventListener('click', () => {
  const rows = readMilestoneInputs();
  rows.push({ title: '', amount: '', due: '' });
  renderMilestoneFields(rows);
  const last = milestoneFields.querySelector('fieldset:last-child input');
  if (last instanceof HTMLInputElement) last.focus();
  showTotal();
});
costInput.addEventListener('input', showTotal);
currencyInput.addEventListener('input', showTotal);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!current) return;
  const o = current;
  clearFieldErrors(form);
  const currency = currencyInput.value.trim().toUpperCase();
  /** @type {{ field: string, message: string }[]} */
  const problems = [];
  const amount = (/** @type {string} */ text, /** @type {string} */ field) => {
    const minor = parseAmountText(text, /^[A-Z]{3}$/.test(currency) ? currency : 'ZAR');
    if (minor === null) {
      problems.push({ field, message: 'must be an amount such as 3000.00' });
      return null;
    }
    return Number(minor);
  };
  const day = (/** @type {string} */ text, /** @type {string} */ field) => {
    if (text.trim() === '') return null;
    const iso = isoDay(text);
    if (!iso) problems.push({ field, message: 'must be a real date as DD/MM/YYYY' });
    return iso;
  };
  const payload = {
    agreedCostMinor: amount(costInput.value, 'agreedCostMinor'),
    currency,
    due: day(dueInput.value, 'due'),
    milestones: readMilestoneInputs().map((row, i) => ({
      title: row.title,
      amountMinor: amount(row.amount, `milestones[${String(i)}].amountMinor`),
      due: day(row.due, `milestones[${String(i)}].due`),
      status: o.milestones[i]?.status ?? 'pending',
    })),
  };
  if (problems.length === 0) {
    const validated = validateDeliveryOrderEdit(payload);
    if (!validated.ok) problems.push(...validated.errors);
  }
  if (problems.length > 0) {
    showFieldErrors(form, problems, 'order-');
    deliveryStatus.className = 'alert alert--error';
    deliveryStatus.textContent = 'Some fields need attention. The first one has been selected.';
    return;
  }
  await change(
    saveButton,
    () => apiSend('PATCH', `/v1/delivery-orders/${o.id}`, payload),
    'Saved the cost and milestones.',
  );
});

refreshButton.addEventListener('click', () => void load(refreshButton));

const linked = new URLSearchParams(location.search).get('order');

void mountShell().then(async (me) => {
  if (!me) return;
  mayWrite = canWrite(me.role);
  await load(refreshButton);
  if (linked) {
    try {
      const o = await loadOrder(linked);
      deliveryStatus.className = 'alert alert--success';
      deliveryStatus.textContent = `Opened the delivery order for ${o.jobTitle}.`;
    } catch (error) {
      if (backToLoginOn401(error)) return;
      section.hidden = false;
      deliveryStatus.className = 'alert alert--error';
      deliveryStatus.textContent = error instanceof Error ? error.message : String(error);
    }
  }
});
