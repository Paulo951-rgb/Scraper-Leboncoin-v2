'use strict';

/**
 * Preload de la fenêtre de connexion Google pour AI Studio.
 *
 * Google bloque l'OAuth dans les navigateurs embarqués (Electron) via la
 * détection de plusieurs empreintes, pas seulement l'en-tête User-Agent :
 *   - navigator.userAgentData (Client Hints JS) contient la marque "Electron"
 *   - navigator.webdriver est true dans les automatisations
 *   - window.chrome est absent / incomplet
 *
 * Ce preload override ces objets AVANT les scripts de la page pour que Google
 * voie un vrai Chrome. contextIsolation est volontairement DÉSACTIVÉ sur cette
 * fenêtre (qui ne charge QUE Google) pour pouvoir modifier les objets de la
 * page. nodeIntegration reste false (pas d'accès Node dans la page).
 */

const brands = [
  { brand: 'Not_A Brand', version: '8' },
  { brand: 'Chromium', version: '120' },
  { brand: 'Google Chrome', version: '120' },
];

try {
  Object.defineProperty(navigator, 'userAgentData', {
    configurable: true,
    get: () => ({
      brands,
      mobile: false,
      platform: 'Windows',
      getHighEntropyValues: (hints) => Promise.resolve({
        architecture: 'x86',
        bitness: '64',
        brands,
        fullVersionList: brands,
        mobile: false,
        model: '',
        platform: 'Windows',
        platformVersion: '10.0',
        uaFullVersion: '120.0.0.0',
        wow64: false,
      }),
      toJSON: () => ({ brands, mobile: false, platform: 'Windows' }),
    }),
  });
} catch (e) {
  console.warn('[aistudioLoginPreload] userAgentData override échoué :', e);
}

try {
  Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => false });
} catch (e) {
  console.warn('[aistudioLoginPreload] webdriver override échoué :', e);
}

try {
  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {};
} catch (e) {
  console.warn('[aistudioLoginPreload] window.chrome override échoué :', e);
}

try {
  Object.defineProperty(navigator, 'plugins', {
    configurable: true,
    get: () => [1, 2, 3, 4, 5],
  });
} catch (e) {
  console.warn('[aistudioLoginPreload] plugins override échoué :', e);
}

try {
  Object.defineProperty(navigator, 'languages', {
    configurable: true,
    get: () => ['fr-FR', 'fr', 'en-US', 'en'],
  });
} catch (e) {
  console.warn('[aistudioLoginPreload] languages override échoué :', e);
}
