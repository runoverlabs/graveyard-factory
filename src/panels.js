// @ts-check
// On narrow screens the two side panels become drawers over the map, opened from the top bar, and the
// top bar folds its less used controls into a More menu (styles.css).

/** Keep in step with the max-width of the drawer media query in styles.css. */
export const NARROW_QUERY = '(max-width: 1100px)';

/** @param {Document} doc */
export function initPanels(doc) {
  const narrow = doc.defaultView.matchMedia(NARROW_QUERY);
  const main = /** @type {HTMLElement} */ (doc.querySelector('.main'));
  const buttons = /** @type {HTMLButtonElement[]} */ ([...doc.querySelectorAll('[data-panel]')]);

  // The More menu holds the top bar controls that don't fit on a narrow screen (styles.css).
  const topbar = doc.querySelector('.topbar');
  const more = doc.querySelector('.more-toggle');
  /** @param {boolean} open */
  const showMenu = (open) => {
    topbar.classList.toggle('show-menu', open);
    more.setAttribute('aria-expanded', String(open));
  };
  more.addEventListener('click', () => showMenu(!topbar.classList.contains('show-menu')));
  // Clicks outside the menu close it; the menu's own controls (checkboxes, name, language) keep it open.
  doc.addEventListener('pointerdown', (ev) => {
    const target = /** @type {Element} */ (ev.target);
    if (!target.closest('#topbar-menu, .more-toggle, #canvas-wrap')) showMenu(false); // the map's own handler is below
  }, true);
  doc.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') showMenu(false); });
  // Its buttons (Clear, Import, Export, Copy link, What's new) do one thing, so the menu closes after them.
  doc.getElementById('topbar-menu').addEventListener('click', (ev) => {
    if (/** @type {Element} */ (ev.target).closest('button')) showMenu(false);
  });

  /** @param {string} name '' closes both */
  const show = (name) => {
    showMenu(false);
    main.dataset.panel = name;
    for (const b of buttons) {
      const open = b.dataset.panel === name;
      b.classList.toggle('active', open);
      b.setAttribute('aria-expanded', String(open));
    }
  };
  for (const b of buttons) b.addEventListener('click', () => show(main.dataset.panel === b.dataset.panel ? '' : b.dataset.panel));

  // A tap on the map closes the open drawer or menu instead of editing under it (capture runs before the canvas's own handlers).
  // The editor sees none of that gesture: not the closing finger's moves and lift, nor a second finger put down meanwhile,
  // which it would otherwise take for a fresh single touch.
  const wrap = doc.getElementById('canvas-wrap');
  /** @type {Set<number>} pointers of the gesture that closed a drawer, still down */
  const swallowed = new Set();
  wrap.addEventListener('pointerdown', (ev) => {
    if (!swallowed.size && (!narrow.matches || (!main.dataset.panel && !topbar.classList.contains('show-menu')))) return;
    ev.stopPropagation();
    swallowed.add(ev.pointerId);
    wrap.setPointerCapture(ev.pointerId); // so its lift is seen here even off the map, and a mouse can't leave it stuck
    show('');
  }, true);
  for (const type of ['pointermove', 'pointerup', 'pointercancel']) {
    wrap.addEventListener(type, (ev) => {
      const id = /** @type {PointerEvent} */ (ev).pointerId;
      if (!swallowed.has(id)) return;
      ev.stopPropagation();
      if (type !== 'pointermove') swallowed.delete(id);
    }, true);
  }
  // Picking a tool closes the tools drawer so the map is free to draw on.
  doc.getElementById('tools-panel').addEventListener('click', (ev) => {
    if (narrow.matches && /** @type {HTMLElement} */ (ev.target).closest('.tools button')) show('');
  });
  narrow.addEventListener('change', () => show(''));
  show('');
}
