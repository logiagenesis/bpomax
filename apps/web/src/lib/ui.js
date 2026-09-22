// @ts-check
/**
 * Interaction helpers every page uses (ARB-060, docs/05 section 1).
 *
 * `confirmAction` is the one confirmation used for destructive actions, and `runAction`
 * is the one loading → success / error pattern for async buttons, so the audit rules are
 * met in one place rather than re-implemented per page.
 */

/**
 * Opens a modal confirmation and resolves true only on an explicit confirm. Escape,
 * the cancel button and closing the dialog all resolve false.
 *
 * @param {{ title: string, body: string, confirmLabel: string, danger?: boolean }} options
 * @returns {Promise<boolean>}
 */
export function confirmAction(options) {
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog';
  dialog.setAttribute('aria-labelledby', 'confirm-title');
  dialog.setAttribute('aria-describedby', 'confirm-body');

  const title = document.createElement('h2');
  title.id = 'confirm-title';
  title.textContent = options.title;
  const body = document.createElement('p');
  body.id = 'confirm-body';
  body.textContent = options.body;

  const actions = document.createElement('div');
  actions.className = 'dialog__actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn--secondary';
  cancel.textContent = 'Cancel';
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = `btn ${options.danger ? 'btn--danger' : 'btn--primary'}`;
  confirm.textContent = options.confirmLabel;
  actions.append(cancel, confirm);
  dialog.append(title, body, actions);
  document.body.append(dialog);

  return new Promise((resolve) => {
    let confirmed = false;
    confirm.addEventListener('click', () => {
      confirmed = true;
      dialog.close();
    });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(confirmed);
    });
    dialog.showModal();
    // The safe choice has focus, so a stray Enter cancels rather than confirms.
    cancel.focus();
  });
}

/**
 * Runs an async action from a button: disables it and marks it busy while it runs, then
 * writes the outcome into a live region.
 *
 * @template T
 * @param {HTMLButtonElement} button
 * @param {HTMLElement} status an element with role="status"
 * @param {() => Promise<T>} work
 * @param {{ success: string | ((result: T) => string) }} messages
 * @returns {Promise<T | undefined>}
 */
export async function runAction(button, status, work, messages) {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  status.className = 'alert alert--info';
  status.textContent = 'Working…';
  try {
    const result = await work();
    status.className = 'alert alert--success';
    status.textContent =
      typeof messages.success === 'function' ? messages.success(result) : messages.success;
    return result;
  } catch (error) {
    status.className = 'alert alert--error';
    status.textContent = error instanceof Error ? error.message : String(error);
    return undefined;
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

/**
 * Asks for a line or two of text — a reason, new wording — in a modal form. Resolves
 * the trimmed text on submit, or null on cancel, Escape or closing the dialog. The
 * field is required, so an empty submit stays open with the browser's own message.
 *
 * @param {{ title: string, label: string, confirmLabel: string, initial?: string, danger?: boolean, maxLength?: number }} options
 * @returns {Promise<string | null>}
 */
export function promptText(options) {
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog';
  dialog.setAttribute('aria-labelledby', 'prompt-title');

  const title = document.createElement('h2');
  title.id = 'prompt-title';
  title.textContent = options.title;

  const form = document.createElement('form');
  form.method = 'dialog';
  form.className = 'stack';
  const field = document.createElement('div');
  field.className = 'field';
  const label = document.createElement('label');
  label.className = 'field__label';
  label.htmlFor = 'prompt-text';
  label.textContent = options.label;
  const textarea = document.createElement('textarea');
  textarea.className = 'textarea';
  textarea.id = 'prompt-text';
  textarea.name = 'text';
  textarea.required = true;
  textarea.rows = 4;
  if (options.maxLength) textarea.maxLength = options.maxLength;
  textarea.value = options.initial ?? '';
  field.append(label, textarea);

  const actions = document.createElement('div');
  actions.className = 'dialog__actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn--secondary';
  cancel.textContent = 'Cancel';
  const confirm = document.createElement('button');
  confirm.type = 'submit';
  confirm.className = `btn ${options.danger ? 'btn--danger' : 'btn--primary'}`;
  confirm.textContent = options.confirmLabel;
  actions.append(cancel, confirm);
  form.append(field, actions);
  dialog.append(title, form);
  document.body.append(dialog);

  return new Promise((resolve) => {
    /** @type {string | null} */
    let result = null;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = textarea.value.trim();
      if (!text) {
        textarea.setCustomValidity('Enter some text.');
        textarea.reportValidity();
        return;
      }
      result = text;
      dialog.close();
    });
    textarea.addEventListener('input', () => textarea.setCustomValidity(''));
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    dialog.showModal();
    textarea.focus();
  });
}
