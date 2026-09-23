// @ts-check
import { parsePrivacyNotice } from '@arbitron/core';
import { formatDate } from './lib/format.js';

/**
 * The privacy notice (ARB-015). The wording is the owner's, approved with a legal adviser
 * (docs/02 T-06), and is published as `privacy-notice.json` beside this page
 * (`apps/web/src/public/`). Nothing here writes a sentence of it: until the owner marks
 * it approved the page says the notice is pending, and a file that breaks the rule in
 * `@arbitron/core`'s `parsePrivacyNotice` is not shown at all.
 */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`privacy is missing #${id}`);
  return element;
}

const status = byId('status');
const pending = byId('privacy-pending');
const approval = byId('privacy-approval');
const article = byId('privacy-notice');

async function load() {
  let raw;
  try {
    const response = await fetch('./privacy-notice.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    raw = await response.json();
  } catch (e) {
    status.className = 'alert alert--error';
    status.textContent = `The privacy notice could not be loaded (${e instanceof Error ? e.message : String(e)}). Reload the page to try again.`;
    return;
  }

  const parsed = parsePrivacyNotice(raw);
  if (!parsed.ok) {
    status.className = 'alert alert--error';
    status.textContent =
      'The published privacy notice is incomplete, so none is shown. The site owner needs to correct it.';
    return;
  }

  const notice = parsed.value;
  if (notice.status === 'pending') {
    pending.hidden = false;
    return;
  }

  approval.textContent = `Version ${notice.version}, approved by ${notice.approvedBy} on ${formatDate(`${notice.approvedOn}T12:00:00Z`)}.`;
  approval.hidden = false;
  article.replaceChildren(
    ...notice.sections.map((section) => {
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
