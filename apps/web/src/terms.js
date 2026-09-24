// @ts-check
import { parseTermsOfService } from '@arbitron/core';
import { formatDate } from './lib/format.js';

/**
 * The terms of service (ARB-400, D-068). The wording is the owner's, approved with a
 * legal adviser, and is published as `terms.json` beside this page
 * (`apps/web/src/public/`), in the privacy notice's shape. Nothing here writes a sentence
 * of it: until the owner marks it approved the page says the terms are pending, and the
 * sign-up page stays closed.
 */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`terms is missing #${id}`);
  return element;
}

const status = byId('status');
const pending = byId('terms-pending');
const approval = byId('terms-approval');
const article = byId('terms');

async function load() {
  let raw;
  try {
    const response = await fetch('./terms.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    raw = await response.json();
  } catch (e) {
    status.className = 'alert alert--error';
    status.textContent = `The terms could not be loaded (${e instanceof Error ? e.message : String(e)}). Reload the page to try again.`;
    return;
  }

  const parsed = parseTermsOfService(raw);
  if (!parsed.ok) {
    status.className = 'alert alert--error';
    status.textContent =
      'The published terms are incomplete, so none are shown. The site owner needs to correct them.';
    return;
  }

  const terms = parsed.value;
  if (terms.status === 'pending') {
    pending.hidden = false;
    return;
  }

  approval.textContent = `Version ${terms.version}, approved by ${terms.approvedBy} on ${formatDate(`${terms.approvedOn}T12:00:00Z`)}.`;
  approval.hidden = false;
  article.replaceChildren(
    ...terms.sections.map((section) => {
      const block = document.createElement('section');
      block.className = 'stack';
      const heading = document.createElement('h2');
      heading.textContent = section.heading;
      block.append(heading);
      for (const text of section.paragraphs) {
        const paragraph = document.createElement('p');
        paragraph.textContent = text;
        block.append(paragraph);
      }
      return block;
    }),
  );
  article.hidden = false;
}

void load();
