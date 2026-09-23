// @ts-check
import {
  clientIdentifyingProblems,
  minorToCsvAmount,
  parseAmountText,
  validateSourcingPostEdit,
} from '@arbitron/core';
import { ApiError, apiGet, apiSend } from './lib/api.js';
import { formatDateTime, formatMoney } from './lib/format.js';
import { clearFieldErrors, showFieldErrors } from './lib/forms.js';
import { backToLoginOn401 } from './lib/shell.js';
import { confirmAction, runAction } from './lib/ui.js';

/**
 * The posts panel of the sourcing page (ARB-202). `GET/POST
 * /v1/sourcing-requests/:id/posts`, `PATCH /v1/sourcing-posts/:id`, and `POST
 * …/approve`, `…/posted`, `…/close`. The page checks an edit with the API's own rules
 * (`validateSourcingPostEdit`, and `clientIdentifyingProblems` with what the page knows
 * of the client); the API checks again with everything it knows. Nothing here posts.
 */

/**
 * @typedef {object} Post
 * @property {string} id
 * @property {'freelancer' | 'upwork' | 'fiverr'} platform
 * @property {boolean} manual
 * @property {string} title
 * @property {string} body
 * @property {string | null} budgetMinMinor
 * @property {string | null} budgetMaxMinor
 * @property {string | null} currency
 * @property {'draft' | 'approved' | 'posted' | 'closed' | 'failed'} status
 * @property {string | null} approvedByName
 * @property {string | null} approvedVia
 * @property {string | null} postedAt
 * @property {string} createdAt
 */

/** @typedef {{ id: string, status: string, clientHandle: string | null, jobTitle: string | null }} RequestRef */

const PLATFORM_WORDS = /** @type {Record<string, string>} */ ({
  freelancer: 'Freelancer.com',
  upwork: 'Upwork',
  fiverr: 'Fiverr',
});

const STATE_WORDS = /** @type {Record<string, string>} */ ({
  draft: 'Draft',
  approved: 'Approved',
  posted: 'Posted',
  closed: 'Closed',
  failed: 'Failed',
});

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`sourcing is missing #${id}`);
  return element;
}

const newForm = /** @type {HTMLFormElement} */ (byId('post-new'));
const platformSelect = /** @type {HTMLSelectElement} */ (byId('post-platform'));
const draftButton = /** @type {HTMLButtonElement} */ (byId('post-draft'));
const status = byId('posts-status');
const list = byId('posts');
const empty = byId('posts-empty');

let mayWrite = false;
let mayApprove = false;
/** @type {RequestRef | null} */
let current = null;

/**
 * @param {HTMLButtonElement} button
 * @param {string} reason empty when the button is usable
 */
function gate(button, reason) {
  button.disabled = reason !== '';
  if (reason) button.title = reason;
  else button.removeAttribute('title');
}

/** @param {Post} p */
function budgetText(p) {
  if (!p.currency || (p.budgetMinMinor === null && p.budgetMaxMinor === null))
    return 'No budget named';
  const min = p.budgetMinMinor === null ? null : formatMoney(BigInt(p.budgetMinMinor), p.currency);
  const max = p.budgetMaxMinor === null ? null : formatMoney(BigInt(p.budgetMaxMinor), p.currency);
  return min && max && min !== max ? `${min} – ${max}` : (max ?? min ?? '');
}

/**
 * @param {string} label
 * @param {string} id
 * @param {HTMLElement} control
 */
function field(label, id, control) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const l = document.createElement('label');
  l.className = 'field__label';
  l.htmlFor = id;
  l.textContent = label;
  control.id = id;
  control.setAttribute('aria-describedby', `${id}-error`);
  const error = document.createElement('p');
  error.className = 'field__error';
  error.id = `${id}-error`;
  error.hidden = true;
  wrap.append(l, control, error);
  return wrap;
}

/** @param {Post} p */
function card(p) {
  const name = PLATFORM_WORDS[p.platform] ?? p.platform;
  const article = document.createElement('article');
  article.className = 'card stack';
  article.dataset.id = p.id;
  article.dataset.status = p.status;
  article.setAttribute('aria-labelledby', `post-${p.id}-heading`);

  const head = document.createElement('div');
  head.className = 'cluster';
  const heading = document.createElement('h4');
  heading.id = `post-${p.id}-heading`;
  heading.textContent = `${name} post`;
  const badge = document.createElement('span');
  badge.className = `badge badge--${p.status === 'posted' ? 'go' : p.status === 'approved' ? 'live' : p.status === 'draft' ? 'caution' : 'neutral'}`;
  badge.textContent = STATE_WORDS[p.status] ?? p.status;
  head.append(heading, badge);

  const title = document.createElement('p');
  const strong = document.createElement('strong');
  strong.textContent = p.title;
  title.append(strong);
  const body = document.createElement('pre');
  body.className = 'bid__body';
  body.textContent = p.body;

  const meta = document.createElement('p');
  meta.className = 'field__hint';
  meta.textContent = [
    `Budget: ${budgetText(p)}`,
    p.approvedByName ? `approved by ${p.approvedByName} via ${p.approvedVia ?? '?'}` : null,
    p.postedAt ? `posted ${formatDateTime(p.postedAt)}${p.manual ? ' by hand' : ''}` : null,
    `drafted ${formatDateTime(p.createdAt)}`,
  ]
    .filter(Boolean)
    .join(' · ');

  // The edit form, hidden until Edit is pressed.
  const prefix = `post-${p.id}-`;
  const form = document.createElement('form');
  form.className = 'stack';
  form.noValidate = true;
  form.hidden = true;
  const titleInput = document.createElement('input');
  titleInput.className = 'input';
  titleInput.maxLength = 120;
  titleInput.value = p.title;
  const bodyInput = document.createElement('textarea');
  bodyInput.className = 'textarea';
  bodyInput.rows = 10;
  bodyInput.value = p.body;
  const currencyInput = document.createElement('input');
  currencyInput.className = 'input';
  currencyInput.maxLength = 3;
  currencyInput.placeholder = 'ZAR';
  currencyInput.value = p.currency ?? '';
  const minInput = document.createElement('input');
  minInput.className = 'input';
  minInput.inputMode = 'decimal';
  minInput.value = p.currency ? minorToCsvAmount(p.budgetMinMinor, p.currency) : '';
  const maxInput = document.createElement('input');
  maxInput.className = 'input';
  maxInput.inputMode = 'decimal';
  maxInput.value = p.currency ? minorToCsvAmount(p.budgetMaxMinor, p.currency) : '';
  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.append(
    field('Budget currency', `${prefix}currency`, currencyInput),
    field('Budget from', `${prefix}budgetMinMinor`, minInput),
    field('Budget to', `${prefix}budgetMaxMinor`, maxInput),
  );
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn--primary';
  save.textContent = 'Save post';
  save.setAttribute('aria-label', `Save the ${name} post`);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn--secondary';
  cancel.textContent = 'Cancel';
  cancel.setAttribute('aria-label', `Cancel editing the ${name} post`);
  const formActions = document.createElement('div');
  formActions.className = 'row-actions';
  formActions.append(save, cancel);
  form.append(
    field('Post title', `${prefix}title`, titleInput),
    field('Post text', `${prefix}body`, bodyInput),
    grid,
    formActions,
  );

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'btn btn--secondary';
  edit.textContent = 'Edit';
  edit.setAttribute('aria-label', `Edit the ${name} post`);
  gate(
    edit,
    !mayWrite
      ? 'Your role can view posts but not change them.'
      : !['draft', 'approved'].includes(p.status)
        ? `This post is ${STATE_WORDS[p.status]?.toLowerCase() ?? p.status}, so it cannot be changed.`
        : '',
  );
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'btn btn--primary';
  approve.textContent = 'Approve';
  approve.setAttribute('aria-label', `Approve the ${name} post`);
  gate(
    approve,
    !mayApprove
      ? 'Your role can view posts but not approve them.'
      : p.status !== 'draft'
        ? `This post is ${STATE_WORDS[p.status]?.toLowerCase() ?? p.status}, so it cannot be approved.`
        : '',
  );
  actions.append(edit, approve);
  if (p.manual) {
    const posted = document.createElement('button');
    posted.type = 'button';
    posted.className = 'btn btn--secondary';
    posted.textContent = 'Record as posted';
    posted.setAttribute('aria-label', `Record the ${name} post as posted by hand`);
    gate(
      posted,
      !mayWrite
        ? 'Your role can view posts but not change them.'
        : p.status !== 'approved'
          ? p.status === 'posted'
            ? 'This post is already recorded as posted.'
            : 'Approve the post first, then post it by hand and record it here.'
          : '',
    );
    posted.addEventListener('click', () => void act(posted, p, 'posted'));
    actions.append(posted);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn--ghost';
  close.textContent = 'Close';
  close.setAttribute('aria-label', `Close the ${name} post`);
  gate(
    close,
    !mayWrite
      ? 'Your role can view posts but not change them.'
      : p.status === 'closed'
        ? 'This post is already closed.'
        : '',
  );
  actions.append(close);

  edit.addEventListener('click', () => {
    form.hidden = false;
    actions.hidden = true;
    titleInput.focus();
  });
  cancel.addEventListener('click', () => {
    clearFieldErrors(form);
    form.hidden = true;
    actions.hidden = false;
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveEdit(save, p, form, {
      title: titleInput.value,
      body: bodyInput.value,
      currency: currencyInput.value,
      min: minInput.value,
      max: maxInput.value,
    });
  });
  approve.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: `Approve the ${name} post?`,
      body: p.manual
        ? 'Approving it means you may post these words by hand on the platform, then record it here.'
        : 'Approving it lets the sender post these words on Freelancer.com once live mode allows it. An edit afterwards clears the approval.',
      confirmLabel: 'Approve',
    });
    if (ok) void act(approve, p, 'approve');
  });
  close.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: `Close the ${name} post?`,
      body: 'A closed post cannot be edited, approved or posted. A new draft can be made for the platform afterwards.',
      confirmLabel: 'Close the post',
      danger: true,
    });
    if (ok) void act(close, p, 'close');
  });

  article.append(head, title, body, meta, actions, form);
  return article;
}

/** @param {Post[]} posts */
function render(posts) {
  list.replaceChildren(...posts.map(card));
  empty.hidden = posts.length !== 0;
}

/** @param {RequestRef} request */
export async function loadPosts(request) {
  current = request;
  gate(
    draftButton,
    !mayWrite
      ? 'Your role can view posts but not draft them.'
      : !['open', 'shortlisting'].includes(request.status)
        ? 'This request is no longer open, so no new post is drafted for it.'
        : '',
  );
  status.className = '';
  status.textContent = '';
  try {
    const body = /** @type {{ posts: Post[] }} */ (
      await apiGet(`/v1/sourcing-requests/${request.id}/posts`)
    );
    render(body.posts);
  } catch (error) {
    if (backToLoginOn401(error)) return;
    status.className = 'alert alert--error';
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function reload() {
  if (current) await loadPosts(current);
}

/**
 * @param {HTMLButtonElement} button
 * @param {Post} p
 * @param {'approve' | 'posted' | 'close'} action
 */
async function act(button, p, action) {
  const name = PLATFORM_WORDS[p.platform] ?? p.platform;
  const text = {
    approve: `Approved the ${name} post.`,
    posted: `Recorded the ${name} post as posted by hand.`,
    close: `Closed the ${name} post.`,
  }[action];
  const keep = { value: '' };
  const done = await runAction(
    button,
    status,
    async () => {
      try {
        return await apiSend('POST', `/v1/sourcing-posts/${p.id}/${action}`);
      } catch (error) {
        if (backToLoginOn401(error)) return undefined;
        throw error;
      }
    },
    { success: () => (keep.value = text) },
  );
  if (done) {
    await reload();
    status.className = 'alert alert--success';
    status.textContent = keep.value;
  }
}

/**
 * @param {HTMLButtonElement} button
 * @param {Post} p
 * @param {HTMLFormElement} form
 * @param {{ title: string, body: string, currency: string, min: string, max: string }} typed
 */
async function saveEdit(button, p, form, typed) {
  const prefix = `post-${p.id}-`;
  clearFieldErrors(form);
  /** @type {{ field: string, message: string }[]} */
  const problems = [];
  const currency = typed.currency.trim().toUpperCase();
  const amount = (/** @type {string} */ text, /** @type {string} */ field) => {
    if (text.trim() === '') return null;
    const minor = parseAmountText(text, currency || 'ZAR');
    if (minor === null) {
      problems.push({ field, message: 'must be an amount such as 8000.00' });
      return null;
    }
    return Number(minor);
  };
  const payload = {
    title: typed.title,
    body: typed.body,
    currency: currency || null,
    budgetMinMinor: amount(typed.min, 'budgetMinMinor'),
    budgetMaxMinor: amount(typed.max, 'budgetMaxMinor'),
  };
  const validated = validateSourcingPostEdit(payload);
  if (!validated.ok) problems.push(...validated.errors);
  else if (current) {
    problems.push(
      ...clientIdentifyingProblems(validated.value, {
        clientHandle: current.clientHandle,
        jobTitle: current.jobTitle,
        signOffName: null,
        jobExternalId: null,
      }),
    );
  }
  if (problems.length > 0) {
    showFieldErrors(form, problems, prefix);
    status.className = 'alert alert--error';
    status.textContent = 'Some fields need attention. The first one has been selected.';
    return;
  }
  const name = PLATFORM_WORDS[p.platform] ?? p.platform;
  const done = await runAction(
    button,
    status,
    async () => {
      try {
        return /** @type {{ post: Post }} */ (
          await apiSend('PATCH', `/v1/sourcing-posts/${p.id}`, payload)
        );
      } catch (error) {
        if (backToLoginOn401(error)) return undefined;
        if (error instanceof ApiError && error.errors.length > 0) {
          showFieldErrors(form, error.errors, prefix);
          // The API's own sentence says why, where the page's generic one would not.
          if (error.status === 422 && error.errors.some((e) => /contains|repeats/.test(e.message)))
            throw new Error(
              'The post could identify the client. Take out what is named and save again.',
            );
        }
        throw error;
      }
    },
    {
      success: () =>
        p.status === 'approved'
          ? `Saved the ${name} post. Its approval is cleared; approve it again when it is right.`
          : `Saved the ${name} post.`,
    },
  );
  if (done) {
    const message = status.textContent;
    await reload();
    status.className = 'alert alert--success';
    status.textContent = message;
  }
}

newForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!current) return;
  const request = current;
  const platform = platformSelect.value;
  const name = PLATFORM_WORDS[platform] ?? platform;
  void (async () => {
    const done = await runAction(
      draftButton,
      status,
      async () => {
        try {
          return await apiSend('POST', `/v1/sourcing-requests/${request.id}/posts`, { platform });
        } catch (error) {
          if (backToLoginOn401(error)) return undefined;
          throw error;
        }
      },
      {
        success: () =>
          `Drafted the ${name} post from the brief’s scope. Read it, edit it, then approve it.`,
      },
    );
    if (done) {
      const message = status.textContent;
      await reload();
      status.className = 'alert alert--success';
      status.textContent = message;
    }
  })();
});

/** @param {{ mayWrite: boolean, mayApprove: boolean }} roles */
export function setPostRoles(roles) {
  mayWrite = roles.mayWrite;
  mayApprove = roles.mayApprove;
}
