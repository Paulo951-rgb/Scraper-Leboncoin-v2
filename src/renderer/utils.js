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
    if (p.some((n) => n > 255)) return null;
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return null;
    if (p[0] === 169 && p[1] === 254) return null;              // link-local (métadonnées cloud)
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return null;  // 172.16/12
    if (p[0] === 192 && p[1] === 168) return null;              // 192.168/16
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return null; // CGNAT 100.64/10
  }
  // IPv6 loopback / unique-local / link-local.
  if (/^[0-9a-f:]+$/i.test(host) && host.includes(':')) {
    if (host === '::1' || host === '::') return null;
    if (/^f[cd]/.test(host)) return null; // fc00::/7 (ULA)
    if (/^fe80/.test(host)) return null;  // link-local
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
