// @ts-check
// Applying the current language to the page's static HTML. Elements carry
// `data-i18n` (text), `data-i18n-html` (text with our own markup),
// `data-i18n-title`, `data-i18n-aria-label` or `data-i18n-placeholder`, each
// holding a string key; the English text in the HTML is the fallback.

import { t, getLanguage, LANGUAGES } from './i18n.js';

const ATTRS = ['title', 'aria-label', 'placeholder'];

/** @param {Document} doc */
export function translateDocument(doc) {
  doc.documentElement.lang = getLanguage() === 'pt-br' ? 'pt-BR' : getLanguage() === 'zh-cn' ? 'zh-CN' : getLanguage();
  for (const el of doc.querySelectorAll('[data-i18n]')) el.textContent = t(/** @type {HTMLElement} */ (el).dataset.i18n);
  for (const el of doc.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(/** @type {HTMLElement} */ (el).dataset.i18nHtml);
  for (const attr of ATTRS) {
    for (const el of doc.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
  }
}

/**
 * Fill the language selector and call `onChange(code)` when the visitor picks one.
 * @param {Document} doc
 * @param {(code: string) => void} onChange
 */
export function initLanguageSelect(doc, onChange) {
  const select = /** @type {HTMLSelectElement | null} */ (doc.getElementById('language'));
  if (!select) return;
  select.replaceChildren(...LANGUAGES.map((l) => {
    const o = doc.createElement('option');
    o.value = l.code;
    o.textContent = l.label;
    return o;
  }));
  select.value = getLanguage();
  select.addEventListener('change', () => onChange(select.value));
}
