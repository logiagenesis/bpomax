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
