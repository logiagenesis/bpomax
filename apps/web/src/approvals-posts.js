// @ts-check
import { apiSend } from './lib/api.js';
import { formatDateTime, formatMoney } from './lib/format.js';
import { backToLoginOn401 } from './lib/shell.js';
import { confirmAction, runAction } from './lib/ui.js';

/**
 * Sourcing posts on the approvals page (ARB-210, D-054: docs/01 section I lists "all
 * pending outbound items"). `GET /v1/sourcing-posts?status=` lists them; Approve and Close
 * are the sourcing page's own calls (`POST /v1/sourcing-posts/:id/approve`, `…/close`),
 * with the same confirmations. The words are edited on the sourcing page, where the
 * client-identity check sits beside the brief, so Edit is a link there.
 */

/**
 * @typedef {object} ApprovalPost
 * @property {string} id
 * @property {string} sourcingRequestId
 * @property {string} briefTitle
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
 * @property {string | null} externalId
 * @property {string | null} failureReason
 * @property {string} createdAt
 */

/**
 * @typedef {object} PostCardContext
 * @property {boolean} mayApprove
 * @property {HTMLElement} status
 * @property {() => Promise<void>} reload
 * @property {(status: string) => HTMLElement} statusBadge
 * @property {(term: string, value: string) => HTMLElement[]} figure
 */

export const PLATFORM_WORDS = /** @type {Record<string, string>} */ ({
  freelancer: 'Freelancer.com',
  upwork: 'Upwork',
  fiverr: 'Fiverr',
});

/**
 * The approvals page's filter words onto a post's states. A post is closed rather than
 * rejected, so "Rejected" shows closed posts; "Sent" shows posted ones.
 */
export const POST_STATE = /** @type {Record<string, string>} */ ({
  queued: 'draft',
  approved: 'approved',
  submitted: 'posted',
  rejected: 'closed',
  failed: 'failed',
  all: 'all',
});

/** A post's state in the page's badge words: a draft is waiting, like a queued bid. */
const BADGE_STATE = /** @type {Record<string, string>} */ ({
  draft: 'queued',
  approved: 'approved',
  posted: 'posted',
  closed: 'closed',
  failed: 'failed',
});

/** @param {ApprovalPost} p */
function budgetText(p) {
  if (!p.currency || (p.budgetMinMinor === null && p.budgetMaxMinor === null)) return 'No budget';
  const from = p.budgetMinMinor === null ? null : formatMoney(BigInt(p.budgetMinMinor), p.currency);
  const to = p.budgetMaxMinor === null ? null : formatMoney(BigInt(p.budgetMaxMinor), p.currency);
  return from && to ? `${from} to ${to}` : (from ?? to ?? 'No budget');
}

/**
 * @param {ApprovalPost} p
 * @param {PostCardContext} ctx
 */
export function postCard(p, ctx) {
  const name = PLATFORM_WORDS[p.platform] ?? p.platform;
  const label = `${name} post for ${p.briefTitle}`;
  const article = document.createElement('article');
  article.className = 'card stack';
  article.dataset.id = p.id;
  article.dataset.kind = 'post';
  article.setAttribute('aria-labelledby', `post-${p.id}-title`);

  const head = document.createElement('div');
  head.className = 'cluster';
  const title = document.createElement('h2');
  title.id = `post-${p.id}-title`;
  title.textContent = `Sourcing post on ${name}`;
  head.append(title, ctx.statusBadge(BADGE_STATE[p.status] ?? p.status));

  const figures = document.createElement('dl');
  figures.className = 'bid__figures';
  figures.append(
    ...ctx.figure('Brief', p.briefTitle),
    ...ctx.figure('Title', p.title),
    ...ctx.figure('Budget', budgetText(p)),
    ...ctx.figure('Drafted', formatDateTime(p.createdAt)),
  );
  if (p.approvedByName)
    figures.append(...ctx.figure('Approved by', `${p.approvedByName} via ${p.approvedVia ?? '?'}`));
  if (p.postedAt)
    figures.append(
      ...ctx.figure(
        'Posted',
        `${formatDateTime(p.postedAt)}${p.manual ? ' by hand' : p.externalId ? `, project ${p.externalId}` : ''}`,
      ),
    );
  if (p.failureReason) figures.append(...ctx.figure('Failure', p.failureReason));

  const body = document.createElement('pre');
  body.className = 'bid__body';
  body.textContent = p.body;

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'btn btn--primary';
  approve.textContent = 'Approve';
  approve.setAttribute('aria-label', `Approve the ${label}`);
  const edit = document.createElement('a');
  edit.className = 'btn btn--secondary';
  edit.textContent = 'Edit on the sourcing page';
  edit.href = `sourcing.html?request=${encodeURIComponent(p.sourcingRequestId)}`;
  edit.setAttribute('aria-label', `Edit the ${label} on the sourcing page`);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn--danger';
  close.textContent = 'Close';
  close.setAttribute('aria-label', `Close the ${label}`);

  const needsBudget =
    p.platform === 'freelancer' &&
    (!p.currency || (p.budgetMinMinor === null && p.budgetMaxMinor === null));
  const approveWhy = !ctx.mayApprove
    ? 'Your role can view sourcing posts but not change them.'
    : p.status !== 'draft'
      ? 'Only a draft is approved.'
      : needsBudget
        ? 'A Freelancer.com post needs a budget before it is approved. Edit it to add one.'
        : '';
  if (approveWhy) {
    approve.disabled = true;
    approve.title = approveWhy;
  }
  const closeWhy = !ctx.mayApprove
    ? 'Your role can view sourcing posts but not change them.'
    : p.status === 'closed'
      ? 'This post is closed.'
      : '';
  if (closeWhy) {
    close.disabled = true;
    close.title = closeWhy;
  }

  /**
   * @param {HTMLButtonElement} button
   * @param {'approve' | 'close'} action
   * @param {string} success
   */
  const act = async (button, action, success) => {
    const done = await runAction(
      button,
      ctx.status,
      async () => {
        try {
          return await apiSend('POST', `/v1/sourcing-posts/${p.id}/${action}`);
        } catch (e) {
          if (backToLoginOn401(e)) return undefined;
          throw e;
        }
      },
      { success },
    );
    if (done) await ctx.reload();
  };

  approve.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: `Approve the ${name} post?`,
      body: p.manual
        ? 'Approving it means you may post these words by hand on the platform, then record it on the sourcing page.'
        : 'Approving it lets the sender post these words on Freelancer.com once live mode allows it. An edit afterwards clears the approval.',
      confirmLabel: 'Approve',
    });
    if (ok)
      await act(
        approve,
        'approve',
        p.manual
          ? `Approved the ${label}.`
          : `Approved the ${label}. It is posted when live mode allows; until then the audit log shows what would be sent.`,
      );
  });
  close.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: `Close the ${name} post?`,
      body: 'A closed post cannot be edited, approved or posted. A new draft can be made for the platform afterwards.',
      confirmLabel: 'Close the post',
      danger: true,
    });
    if (ok) await act(close, 'close', `Closed the ${label}.`);
  });

  actions.append(approve, edit, close);
  article.append(head, figures, body, actions);
  return article;
}
