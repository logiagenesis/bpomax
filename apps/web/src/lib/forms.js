// @ts-check
/**
 * Field errors on a form (docs/05 section 1.5 and 1.6). A field's error lives in the
 * element `<p class="field__error" id="<field>-error">` next to it, is announced through
 * `aria-describedby`, and marks the input `aria-invalid`. The same list of
 * `{ field, message }` comes from the validators in `@arbitron/core` before a request
 * and from the API's 422 after one, so both are shown the same way.
 */

/**
 * @param {HTMLElement} form
 * @param {readonly { field: string, message: string }[]} errors
 * @param {string} [prefix] an id prefix when a form hosts several records
 * @returns {boolean} whether any error was placed on a field
 */
export function showFieldErrors(form, errors, prefix = '') {
  clearFieldErrors(form);
  let placed = false;
  for (const error of errors) {
    const id = `${prefix}${error.field.replace(/[[\].]/g, '-').replace(/-+$/, '')}`;
    const input = form.querySelector(`#${CSS.escape(id)}`);
    const slot = form.querySelector(`#${CSS.escape(`${id}-error`)}`);
    if (!(slot instanceof HTMLElement)) continue;
    const text = error.message.charAt(0).toUpperCase() + error.message.slice(1);
    slot.textContent = text.endsWith('.') ? text : `${text}.`;
    slot.hidden = false;
    if (input instanceof HTMLElement) input.setAttribute('aria-invalid', 'true');
    placed = true;
  }
  const first = form.querySelector('[aria-invalid="true"]');
  if (first instanceof HTMLElement) first.focus();
  return placed;
}

/** @param {HTMLElement} form */
export function clearFieldErrors(form) {
  for (const slot of form.querySelectorAll('.field__error')) {
    slot.textContent = '';
    /** @type {HTMLElement} */ (slot).hidden = true;
  }
  for (const input of form.querySelectorAll('[aria-invalid]'))
    input.removeAttribute('aria-invalid');
}

/**
 * An amount typed in rand — "1 500", "1500,50", "1500.5" — as whole cents, in a string
 * so no float is involved. Null when it is not an amount.
 * @param {string} text
 * @returns {string | null}
 */
export function parseRandToMinor(text) {
  const cleaned = text.replace(/[\sR]/g, '');
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(2, '0');
  return String(BigInt(`${whole}${fraction}`));
}

/**
 * Whole cents as rand for an input: 150050 → "1500,50".
 * @param {string | number | null} minor
 */
export function minorToRandInput(minor) {
  if (minor === null || minor === '') return '';
  const digits = String(minor).padStart(3, '0');
  return `${digits.slice(0, -2)},${digits.slice(-2)}`;
}
