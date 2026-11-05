// @ts-check
// On narrow screens the two side panels become drawers over the map (styles.css), opened from the top bar.

/** Keep in step with the max-width of the drawer media query in styles.css. */
export const NARROW_QUERY = '(max-width: 1100px)';

/** @param {Document} doc */
export function initPanels(doc) {
  const narrow = doc.defaultView.matchMedia(NARROW_QUERY);
  const main = /** @type {HTMLElement} */ (doc.querySelector('.main'));
  const buttons = /** @type {HTMLButtonElement[]} */ ([...doc.querySelectorAll('[data-panel]')]);

  /** @param {string} name '' closes both */
  const show = (name) => {
    main.dataset.panel = name;
    for (const b of buttons) {
      const open = b.dataset.panel === name;
      b.classList.toggle('active', open);
      b.setAttribute('aria-expanded', String(open));
    }
  };
  for (const b of buttons) b.addEventListener('click', () => show(main.dataset.panel === b.dataset.panel ? '' : b.dataset.panel));

  // A tap on the map closes the open drawer instead of editing under it (capture runs before the canvas's own handlers).
  doc.getElementById('canvas-wrap').addEventListener('pointerdown', (ev) => {
    if (!narrow.matches || !main.dataset.panel) return;
    ev.stopPropagation();
    show('');
  }, true);
  // Picking a tool closes the tools drawer so the map is free to draw on.
  doc.getElementById('tools-panel').addEventListener('click', (ev) => {
    if (narrow.matches && /** @type {HTMLElement} */ (ev.target).closest('.tools button')) show('');
  });
  narrow.addEventListener('change', () => show(''));
  show('');
}
