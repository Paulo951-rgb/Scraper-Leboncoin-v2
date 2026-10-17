function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Placeholder d'image 100% local (data-URI SVG) — évite toute dépendance réseau
// (via.placeholder.com) lorsqu'une annonce n'a pas de photo ou en mode hors-ligne.
const PLACEHOLDER_SVG = (label) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='250'><rect width='100%' height='100%' fill='#1e293b'/><text x='50%' y='50%' fill='#64748b' font-family='sans-serif' font-size='18' text-anchor='middle' dominant-baseline='middle'>${label || 'Pas de photo'}</text></svg>`
  )}`;
const noPhotoUrl = () => PLACEHOLDER_SVG('Pas de photo');

/**
 * Décompose une adresse IPv6 littérale en 8 groupes de 16 bits.
 * Renvoie null si l'adresse n'est pas exploitable (fail-closed).
 * Gère la forme compressée `::` et la notation IPv4 en suffixe (`::ffff:1.2.3.4`).
 * @param {string} host hostname sans crochets, en minuscules
 * @returns {number[]|null}
 */
function _ipv6Groups(host) {
  let h = host;
  // Suffixe IPv4 (ex. ::ffff:127.0.0.1) → deux groupes hexadécimaux.
  const v4 = h.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    if (o.some((n) => n > 255)) return null;
    const hex = ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
    h = h.slice(0, v4.index) + hex;
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const parse = (s) => (s === '' ? [] : s.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  if ([...left, ...right].some((n) => Number.isNaN(n))) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  return [...left, ...new Array(fill).fill(0), ...right];
}

/** Octets IPv4 privés/loopback/link-local/CGNAT/réservés (fail-closed si hors bornes). */
function _isPrivateIPv4Octets(a, b, c, d) {
  if ([a, b, c, d].some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;                 // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;        // 172.16/12
  if (a === 192 && b === 168) return true;                 // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT
  return false;
}

/**
 * Valide une URL d'image AVANT de l'assigner à `img.src`.
 *
 * Les URL proviennent d'un fichier `annonces.json` (données scrapées ou fichier
 * modifié par un tiers) : les charger sans contrôle permettrait de faire
 * émettre au renderer des requêtes vers des adresses locales/internes
 * (SSRF-style) via `http://127.0.0.1/…`, `http://192.168.x.x/…`, `file:///…`.
 * On n'autorise donc que http(s) vers des domaines NON privés, et on rejette
 * les schémas exotiques (`data:` est toléré uniquement pour nos placeholders).
 * Les domaines d'images Leboncoin sont évidemment acceptés.
 *
 * @param {*} raw URL candidate
 * @returns {string|null} URL sûre, ou null si rejetée
 */
function sanitizeImageUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s === '') return null;
  // Nos propres placeholders (data:image/svg+xml) restent autorisés.
  if (/^data:image\/svg\+xml/i.test(s)) return s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return null;
  // IPv4 privée / loopback / link-local / CGNAT.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const p = host.split('.').map(Number);
    if (_isPrivateIPv4Octets(p[0], p[1], p[2], p[3])) return null;
  }
  // IPv6 (dont les formes littérales) : on ramène d'abord l'adresse à sa forme
  // canonique pour ne pas se laisser contourner par une écriture compressée ou
  // mappée. `new URL` réécrit déjà `::ffff:127.0.0.1` en `::ffff:7f00:1` et
  // `0:0:0:0:0:0:0:1` en `::1` : comparer des préfixes sur la chaîne d'origine
  // laissait passer les adresses IPv4-mappées (SSRF) et les préfixes non
  // compressés (`fc00::` écrit `fc00:0:...`).
  if (/^[0-9a-f:]+$/i.test(host) && host.includes(':')) {
    const groups = _ipv6Groups(host);
    if (!groups) return null; // IPv6 illisible : on refuse (fail-closed).
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
    // Loopback ::1 et non-spécifiée ::.
    if (groups.every((g, i) => g === (i === 7 ? 1 : 0))) return null;
    if (groups.every((g) => g === 0)) return null;
    // IPv4-mappée (::ffff:a.b.c.d) et IPv4-compatible (::a.b.c.d) : on rejoue le
    // contrôle IPv4 sur les 32 derniers bits (sinon 127.0.0.1 déguisé passait).
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
      const a = (g6 >> 8) & 0xff, b = g6 & 0xff, c = (g7 >> 8) & 0xff, d = g7 & 0xff;
      if (_isPrivateIPv4Octets(a, b, c, d)) return null;
    }
    // fc00::/7 (ULA) : préfixe 1111 110.
    if ((g0 & 0xfe00) === 0xfc00) return null;
    // fe80::/10 (link-local).
    if ((g0 & 0xffc0) === 0xfe80) return null;
    // ::/96 non mappée (déjà couvert plus haut) et 64:ff9b::/96 (NAT64) : les
    // adresses NAT64 encapsulent une IPv4 ; on rejoue le contrôle IPv4 dessus.
    if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
      const a = (g6 >> 8) & 0xff, b = g6 & 0xff, c = (g7 >> 8) & 0xff, d = g7 & 0xff;
      if (_isPrivateIPv4Octets(a, b, c, d)) return null;
    }
  }
  return u.toString();
}

/**
 * Lit la ville d'une annonce en tolérant TOUTES les variantes de nommage
 * rencontrées selon la source : le modèle interne (`city`) et la clé d'export
 * (`ville`) sont écrits par le pipeline, mais d'anciens JSON peuvent n'avoir
 * qu'un des deux, voire un objet `location`. Sans cette résolution, la ville
 * s'affichait « Inconnue » alors que la donnée existait.
 * @param {object} a
 * @returns {string} ville ou '' si absente (jamais inventée)
 */
function cityOf(a) {
  if (!a || typeof a !== 'object') return '';
  const v = a.city ?? a.ville ?? a.location?.city ?? a.location?.city_label ?? a.localisation?.ville;
  return typeof v === 'string' ? v.trim() : (v != null ? String(v).trim() : '');
}

/**
 * Lit le code postal d'une annonce (variantes `zipcode`/`codePostal`).
 * @param {object} a
 * @returns {string} code postal ou '' si absent
 */
function zipOf(a) {
  if (!a || typeof a !== 'object') return '';
  const v = a.zipcode ?? a.codePostal ?? a.location?.zipcode ?? a.localisation?.codePostal;
  return typeof v === 'string' ? v.trim() : (v != null ? String(v).trim() : '');
}

/**
 * Libellé de localisation : ville + code postal si disponibles, sinon
 * 'Inconnue'. N'invente JAMAIS une ville : si la donnée est absente, on
 * l'indique explicitement.
 * @param {object} a
 * @returns {string}
 */
function locationLabel(a) {
  const city = cityOf(a);
  const zip = zipOf(a);
  if (!city && !zip) return 'Inconnue';
  if (city && zip) return `${city} (${zip})`;
  return city || zip;
}

/**
 * Convertit le prix d'une annonce en NOMBRE, en tolérant les formes
 * historiques (chaîne « 1 250 € », « 1.299,99 »). Le modèle actuel expose
 * `prix` en nombre, mais d'anciens jobs/presets peuvent contenir une chaîne :
 * `parseFloat('1 250 €')` → 1 (troncature silencieuse) faussait alors le
 * filtre de prix, le tri et l'affichage de l'explorateur. Même convention que
 * le pipeline (adFields.parsePriceString) et les statistiques.
 * @param {object} a
 * @returns {number} prix (NaN si absent/illisible)
 */
function priceOf(a) {
  if (!a || typeof a !== 'object') return NaN;
  const raw = a.prix ?? a.price;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  if (typeof raw !== 'string') return NaN;
  const cleaned = raw
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(',', '.')
    .replace(/[^\d.-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

// Échappe une valeur injectée dans un attribut HTML contenant du JS
// (ex: onclick="func('VALUE')"). Double contexte : attribut HTML (") +
// chaîne JS ('\). escapeHtml ne convient PAS ici car il transformerait ' en
// &#39; que le navigateur décode en ' avant d'exécuter le JS → casserait la
// chaîne JS. On échappe donc \ et ' pour le JS, puis " et & pour le HTML.
function escapePath(pathStr) {
  if (!pathStr) return '';
  return String(pathStr)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    // '&' en PREMIER (avant '&quot;') : sinon l'échappement des guillemets
    // injecterait un '&' qui serait ensuite transformé en '&amp;' → '&amp;quot;'
    // affiché littéralement et double-encodage. L'ordre initial était buggé.
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

window.openUrl = (urlStr) => {
  if (urlStr) window.api.openExternal(urlStr);
};

// ─── Notifications (toasts) ────────────────────────────────────────────────
// Remplace les alert() natifs (bloquants, non stylables, hors charte). Le
// conteneur #toastContainer est déclaré dans index.html ; si absent (tests,
// contexte dégradé) on retombe silencieusement sur la console pour ne jamais
// jeter. Chaque toast est un élément DOM créé via createElement (pas de
// innerHTML) → le texte fourni ne peut pas injecter de HTML.
const TOAST_ICONS = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌' };
function showToast(message, type = 'info', opts = {}) {
  const text = String(message == null ? '' : message);
  const container = document.getElementById('toastContainer');
  if (!container) { console.log(`[toast:${type}] ${text}`); return null; }
  const duration = Number.isFinite(opts.duration) ? opts.duration : 4000;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', type === 'error' || type === 'warn' ? 'alert' : 'status');

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = TOAST_ICONS[type] || TOAST_ICONS.info;

  const body = document.createElement('span');
  body.className = 'toast-msg';
  body.textContent = text;

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Fermer');
  close.textContent = '×';

  const remove = () => {
    toast.classList.add('toast-hide');
    setTimeout(() => { try { toast.remove(); } catch { /* déjà retiré */ } }, 200);
  };
  close.addEventListener('click', remove);

  toast.appendChild(icon);
  toast.appendChild(body);
  toast.appendChild(close);
  container.appendChild(toast);
  if (duration > 0) setTimeout(remove, duration);
  return toast;
}
window.showToast = showToast;

// ─── Bandeau d'erreur actionnable (onglet Scraper) ──────────────────────────
// Affiche un message d'erreur/succès partiel persistant avec accès direct aux
// logs, au lieu d'un alert() transitoire qui disparaît sans trace.
function showScrapeError({ title, message, type = 'error' } = {}) {
  const banner = document.getElementById('scrapeErrorBanner');
  if (!banner) { showToast(message, type); return; }
  const titleEl = document.getElementById('scrapeErrorTitle');
  const msgEl = document.getElementById('scrapeErrorMessage');
  const iconEl = document.getElementById('scrapeErrorIcon');
  if (titleEl) titleEl.textContent = title || 'Problème détecté';
  if (msgEl) msgEl.textContent = message || '';
  if (iconEl) iconEl.textContent = type === 'warn' ? '⚠️' : type === 'success' ? '✅' : '❌';
  banner.classList.remove('hidden');
  banner.classList.toggle('scrape-error-banner--warn', type === 'warn');
}
window.showScrapeError = showScrapeError;

function hideScrapeError() {
  const banner = document.getElementById('scrapeErrorBanner');
  if (banner) banner.classList.add('hidden');
}
window.hideScrapeError = hideScrapeError;

// ─── Confirmation asynchrone (modal maison) ─────────────────────────────────
// Remplace window.confirm() : non stylable, bloquant le thread, et sans
// contexte visuel. Renvoie une promesse<bool>. Repli sur confirm() natif si la
// modal est absente (tests, contexte dégradé).
function askConfirm({ title = 'Confirmation', message = '', confirmLabel = 'Confirmer' } = {}) {
  const modal = document.getElementById('askModal');
  if (!modal) return Promise.resolve(window.confirm(message || title));
  const titleEl = document.getElementById('askModalTitle');
  const msgEl = document.getElementById('askModalMessage');
  const okBtn = document.getElementById('askModalConfirmBtn');
  const cancelBtn = document.getElementById('askModalCancelBtn');
  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;
  if (okBtn) okBtn.textContent = confirmLabel;

  modal.classList.remove('hidden');

  return new Promise((resolve) => {
    const cleanup = (result) => {
      modal.classList.add('hidden');
      okBtn?.removeEventListener('click', onOk);
      cancelBtn?.removeEventListener('click', onCancel);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    okBtn?.addEventListener('click', onOk);
    cancelBtn?.addEventListener('click', onCancel);
  });
}
window.askConfirm = askConfirm;

// ─── Actions déléguées (Thème 6) ────────────────────────────────────────────
// Remplace les handlers inline (onclick="fn('…')") générés par innerHTML. Ceux-ci
// obligeaient la CSP à autoriser 'unsafe-inline' pour les scripts et reposaient
// sur un échappement manuel (escapePath) pour chaque valeur injectée. On utilise
// désormais des attributs data-* + un unique listener délégué au niveau document
// (les valeurs data-* ne sont pas du code : aucun risque d'exécution). Les
// valeurs sont lues via dataset (déjà décodées par le parseur HTML).
function installDelegatedActions() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    const id = el.dataset.id || '';
    const url = el.dataset.url || '';
    switch (action) {
      case 'openUrl': e.preventDefault(); window.openUrl(url); break;
      case 'openAdDetail': window.openAdDetail && window.openAdDetail(id); break;
      case 'toggleStar': window.toggleStar && window.toggleStar(id); break;
      case 'switchGalleryImg': window.switchGalleryImg && window.switchGalleryImg(url, el); break;
      case 'openFile': window.openFile && window.openFile(id); break;
      case 'openSessionFolder': window.openSessionFolder && window.openSessionFolder(id); break;
      case 'askDeleteJob': window.askDeleteJob && window.askDeleteJob(id); break;
      case 'loadPreset': window.loadPreset && window.loadPreset(Number(id)); break;
      case 'deletePreset': e.stopPropagation(); window.deletePreset && window.deletePreset(Number(id)); break;
      default: break;
    }
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-action="toggleCompare"]');
    if (el) window.toggleCompare && window.toggleCompare(el.dataset.id || '');
  });
}
window.installDelegatedActions = installDelegatedActions;

// ─── Debounce (Thème 7 perf) ────────────────────────────────────────────────
// Retarde l'exécution d'une fonction jusqu'à `wait` ms après le dernier appel.
// Utilisé pour les filtres texte de l'explorateur : sans cela, chaque frappe
// déclenchait un filtrage complet + reconstruction innerHTML de la liste.
function debounce(fn, wait = 150) {
  let timer = null;
  const debounced = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, wait);
  };
  debounced.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return debounced;
}
window.debounce = debounce;

window.openFolder = async (folderPath) => {
  if (!folderPath) return;
  try {
    const res = await window.api.openFolder(folderPath);
    if (res && res.success === false) {
      showToast('Impossible d\'ouvrir le dossier : ' + (res.error || 'erreur inconnue'), 'error');
    }
  } catch (err) {
    showToast('Impossible d\'ouvrir le dossier : ' + (err.message || err), 'error');
  }
};

window.openFile = async (filePath) => {
  if (!filePath) return;
  try {
    const res = await window.api.openFile(filePath);
    if (res && res.success === false) {
      showToast('Impossible d\'ouvrir le fichier : ' + (res.error || 'erreur inconnue'), 'error');
    }
  } catch (err) {
    showToast('Impossible d\'ouvrir le fichier : ' + (err.message || err), 'error');
  }
};

// Ouvre le dossier de résultats d'une session de scraping (JSON, TXT, rapport).
// L'identifiant de session est validé côté main process ; le renderer ne fournit
// jamais de chemin de fichier.
window.openSessionFolder = async (jobId) => {
  if (!jobId) return;
  try {
    const res = await window.api.openSessionFolder(jobId);
    if (res && res.success === false) {
      showToast(res.error || 'Impossible d\'ouvrir le dossier de la session.', 'error');
    }
  } catch (err) {
    showToast('Impossible d\'ouvrir le dossier de la session : ' + (err.message || err), 'error');
  }
};
