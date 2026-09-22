// @ts-check
/**
 * Hands the browser a file to save. Returns the object URL so a test can read it back.
 * @param {string} filename
 * @param {Blob} blob
 */
export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return url;
}
