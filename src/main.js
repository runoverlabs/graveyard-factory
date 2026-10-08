// @ts-check
import { Editor } from './editor.js';
import { initChangelog } from './changelog-ui.js';
import { initWelcome } from './welcome.js';
import { pickLanguage, setLanguage } from './i18n.js';
import { translateDocument, initLanguageSelect } from './i18n-dom.js';

const LANGUAGE_KEY = 'gk2-factory-language';

/** @returns {string | null} */
function savedLanguage() {
  try { return localStorage.getItem(LANGUAGE_KEY); } catch { return null; }
}

// The saved choice, else the browser's language; loaded before the editor draws anything.
await setLanguage(pickLanguage(navigator.languages?.length ? navigator.languages : [navigator.language], savedLanguage()));
translateDocument(document);

// Exposed for debugging from the console.
const editor = new Editor(document);
/** @type {Window & { editor?: Editor }} */ (window).editor = editor;
initLanguageSelect(document, async (code) => {
  await setLanguage(code);
  try { localStorage.setItem(LANGUAGE_KEY, code); } catch { /* storage unavailable */ }
  translateDocument(document);
  editor.relocalize();
});
initChangelog(document, initWelcome(document));
