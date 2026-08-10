'use strict';

// 🎨 THÈME — appliqué au chargement depuis localStorage (le sélecteur est dans la modale Paramètres)
const savedTheme = localStorage.getItem('app-theme') || 'theme-dark';
document.body.className = savedTheme;

// ONGLETS
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));

    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');

    if (btn.dataset.tab === 'tab-history') loadHistoryPage();
    if (btn.dataset.tab === 'tab-explorer') loadExplorerPage();
    if (btn.dataset.tab === 'tab-stats') {
      loadStatsPage();
      // Force Leaflet à recalculer sa taille d'affichage après l'ouverture de l'onglet (anti-bug d'affichage)
      setTimeout(() => {
        if (typeof mapInstance !== 'undefined' && mapInstance) {
          mapInstance.invalidateSize();
        }
      }, 200);
    }
  });
});

// ⌨️ RACCOURCIS CLAVIER PRO
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    document.querySelector('[data-tab="tab-scraper"]').click();
    document.getElementById('searchUrl').focus();
  }
  if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
    e.preventDefault();
    if (viewMode === 'table') viewGridBtn.click();
    else viewTableBtn.click();
  }
  if (e.key === 'Escape') {
    confirmModal.classList.add('hidden');
    adDetailModal.classList.add('hidden');
    compareModal.classList.add('hidden');
    settingsModal.classList.add('hidden');
    // Modales d'aide (FAQ / Help / Feedback)
    document.getElementById('faqModal')?.classList.add('hidden');
    document.getElementById('helpModal')?.classList.add('hidden');
    document.getElementById('feedbackModal')?.classList.add('hidden');
  }
});

// Reste des éléments UI
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusText = document.getElementById('statusText');
const etaText = document.getElementById('etaText');
const progressBar = document.getElementById('progressBar');
const logsConsole = document.getElementById('logsConsole');

// 📶 Mode hors-ligne : détection de connectivité + badge dans l'en-tête.
// L'utilisateur peut consulter les jobs déjà scrapés (lecture disque) mais ne
// peut pas lancer un nouveau scraping ni une analyse IA en ligne.
const offlineBadge = document.getElementById('offlineBadge');
let isOffline = false;

function setOfflineMode(offline) {
  isOffline = offline;
  if (offline) {
    offlineBadge.classList.remove('hidden');
    startBtn.title = 'Indisponible en mode hors-ligne.';
  } else {
    offlineBadge.classList.add('hidden');
    startBtn.title = '';
  }
}

async function refreshConnectivity() {
  try {
    const res = await window.api.checkNetwork();
    setOfflineMode(!res.online);
  } catch {
    setOfflineMode(true);
  }
}

window.addEventListener('online', () => setOfflineMode(false));
window.addEventListener('offline', () => setOfflineMode(true));
setInterval(refreshConnectivity, 60000); // refresh périodique
refreshConnectivity(); // vérification initiale
const clearLogsBtn = document.getElementById('clearLogsBtn');

const historyTableBody = document.getElementById('historyTableBody');
const sessionSelect = document.getElementById('sessionSelect');
const statsSessionSelect = document.getElementById('statsSessionSelect');

const adsTableContainer = document.getElementById('adsTableContainer');
const adsTableBody = document.getElementById('adsTableBody');
const adsGridContainer = document.getElementById('adsGridContainer');
const filteredAdsCount = document.getElementById('filteredAdsCount');

const viewTableBtn = document.getElementById('viewTableBtn');
const viewGridBtn = document.getElementById('viewGridBtn');

const filterKeyword = document.getElementById('filterKeyword');
const filterPriceMin = document.getElementById('filterPriceMin');
const filterPriceMax = document.getElementById('filterPriceMax');
const filterTagSelect = document.getElementById('filterTagSelect');
const sortSelect = document.getElementById('sortSelect');
const triggerMarketBtn = document.getElementById('triggerMarketBtn');

const statTotalAds = document.getElementById('statTotalAds');
const statAvgPrice = document.getElementById('statAvgPrice');
const statMedPrice = document.getElementById('statMedPrice');
const statMinPrice = document.getElementById('statMinPrice');
const statMaxPrice = document.getElementById('statMaxPrice');
const statHandDelivery = document.getElementById('statHandDelivery');
const statPro = document.getElementById('statPro');
const statPart = document.getElementById('statPart');

// Déclarations de sécurité pour l'historique et la suppression
const openMainFolderBtn = document.getElementById('openMainFolderBtn');

// Proxy & AI
const proxyUrl = document.getElementById('proxyUrl');
proxyUrl.value = localStorage.getItem('proxy-url') || '';
proxyUrl.addEventListener('change', (e) => localStorage.setItem('proxy-url', e.target.value));

const autoAiMarket = document.getElementById('autoAiMarket');
const aiVisionModelEl = document.getElementById('aiVisionModel');
const analyzeImages = { checked: true }; // rétro-compat : la vision est désormais intégrée à l'IA Analyse
const aiProvider = document.getElementById('aiProvider');
const aiModelName = document.getElementById('aiModelName');

// Persistance du modèle vision.
if (aiVisionModelEl) {
  aiVisionModelEl.value = localStorage.getItem('ai-vision-model') || 'llava';
  aiVisionModelEl.addEventListener('change', (e) => localStorage.setItem('ai-vision-model', e.target.value));
}

// OpenAI a été retiré de l'UI : il n'y a plus de champ clé API dans le scraper.
// On expose un accesseur sûr (null-tolerant) pour ne pas casser les appels
// existants (config scraping / analyse / scheduler) si l'élément vient à
// disparaître — la clé vaut toujours '' (IA 100% locale via Ollama).
const aiApiKeyEl = document.getElementById('aiApiKey');
const getAiApiKey = () => (aiApiKeyEl && aiApiKeyEl.value ? aiApiKeyEl.value : '');

// Moteur de recherche pour l'IA Marché (Option C : sans-clé par défaut).
// Peuple dynamiquement la liste via le registre côté main process.
const searchProviderSelect = document.getElementById('searchProvider');
const searchApiKeyEl = document.getElementById('searchApiKey');
const getSearchApiKey = () => (searchApiKeyEl && searchApiKeyEl.value ? searchApiKeyEl.value : '');
if (searchProviderSelect) {
  searchProviderSelect.value = localStorage.getItem('search-provider') || 'duckduckgo';
  searchProviderSelect.addEventListener('change', (e) => {
    localStorage.setItem('search-provider', e.target.value);
    // N'affiche le champ clé que pour les moteurs qui en nécessitent une.
    if (searchApiKeyEl && searchApiKeyEl.parentElement) {
      const needsKey = e.target.value !== 'duckduckgo';
      searchApiKeyEl.parentElement.classList.toggle('hidden', !needsKey);
    }
  });
  // Charge la liste des moteurs disponibles depuis le main process.
  window.api.listSearchProviders().then(({ providers } = {}) => {
    if (!Array.isArray(providers) || !searchProviderSelect) return;
    searchProviderSelect.innerHTML = providers
      .map((p) => `<option value="${p.id}">${p.label}${p.keyless ? ' (sans clé)' : ''}</option>`)
      .join('');
    searchProviderSelect.value = localStorage.getItem('search-provider') || 'duckduckgo';
    if (searchApiKeyEl && searchApiKeyEl.parentElement) {
      const needsKey = searchProviderSelect.value !== 'duckduckgo';
      searchApiKeyEl.parentElement.classList.toggle('hidden', !needsKey);
    }
  }).catch(() => { /* liste non disponible — fallback duckduckgo */ });
}

aiModelName.value = localStorage.getItem('ai-model-name') || 'llama3';
aiModelName.addEventListener('change', (e) => localStorage.setItem('ai-model-name', e.target.value));

if (aiProvider) {
  aiProvider.addEventListener('change', () => {
    // Plus que Ollama local désormais ; handler conservé pour compat.
  });
}

// Presets
const presetsRow = document.getElementById('presetsRow');
const savePresetBtn = document.getElementById('savePresetBtn');
let presets = JSON.parse(localStorage.getItem('search-presets') || '[]');

function renderPresets() {
  if (presets.length === 0) {
    presetsRow.innerHTML = '<span class="text-muted font-small">Aucun modèle enregistré.</span>';
    return;
  }
  presetsRow.innerHTML = presets
    .map(
      (p, i) => `
    <div class="preset-chip" onclick="loadPreset(${i})">
      📌 ${escapeHtml(p.name)}
      <span style="color:#ef4444; margin-left:4px;" onclick="event.stopPropagation(); deletePreset(${i})">✕</span>
    </div>
  `
    )
    .join('');
}

// Capture l'intégralité de la configuration de recherche (URL + pages + limite
// + options IA + proxy) afin qu'un preset soit réellement un restauration
// « 1-clic » de la recherche, et pas seulement URL + pages.
function collectSearchConfig() {
  return {
    searchUrl: document.getElementById('searchUrl').value.trim(),
    pages: document.getElementById('pages').value,
    limit: document.getElementById('limit').value,
    noDesc: document.getElementById('noDesc').checked,
    autoAiMarket: autoAiMarket.checked,
    proxyUrl: proxyUrl.value.trim(),
    aiProvider: aiProvider.value,
    aiModelName: aiModelName.value.trim() || 'llama3',
    aiVisionModel: localStorage.getItem('ai-vision-model') || 'llava',
  };
}

// Applique une configuration de recherche sauvegardée dans le formulaire.
// Les champs manquants (presets anciens) retombent sur les valeurs actuelles.
function applySearchConfig(cfg) {
  if (!cfg) return;
  if (cfg.searchUrl) document.getElementById('searchUrl').value = cfg.searchUrl;
  if (cfg.pages != null) document.getElementById('pages').value = cfg.pages;
  if (cfg.limit != null) document.getElementById('limit').value = cfg.limit;
  if (cfg.noDesc != null) document.getElementById('noDesc').checked = cfg.noDesc;
  if (cfg.autoAiMarket != null) autoAiMarket.checked = cfg.autoAiMarket;
  if (cfg.proxyUrl != null) {
    proxyUrl.value = cfg.proxyUrl;
    localStorage.setItem('proxy-url', cfg.proxyUrl);
  }
  if (cfg.aiProvider) aiProvider.value = cfg.aiProvider;
  if (cfg.aiModelName != null) {
    aiModelName.value = cfg.aiModelName;
    localStorage.setItem('ai-model-name', cfg.aiModelName);
  }
  if (cfg.aiVisionModel != null) {
    if (aiVisionModelEl) aiVisionModelEl.value = cfg.aiVisionModel;
    localStorage.setItem('ai-vision-model', cfg.aiVisionModel);
  }
}

savePresetBtn.addEventListener('click', () => {
  const cfg = collectSearchConfig();
  if (!cfg.searchUrl) return alert('Veuillez entrer une URL de recherche.');
  const name = prompt('Nom du modèle de recherche :', 'Ma Recherche');
  if (name) {
    presets.push({ name, ...cfg });
    localStorage.setItem('search-presets', JSON.stringify(presets));
    renderPresets();
  }
});

window.loadPreset = (i) => {
  const p = presets[i];
  if (p) applySearchConfig({ searchUrl: p.url || p.searchUrl, pages: p.pages, ...p });
};

window.deletePreset = (i) => {
  presets.splice(i, 1);
  localStorage.setItem('search-presets', JSON.stringify(presets));
  renderPresets();
};

renderPresets();

// Comparateur
const openCompareModalBtn = document.getElementById('openCompareModalBtn');
const compareModal = document.getElementById('compareModal');
const closeCompareModalBtn = document.getElementById('closeCompareModalBtn');
const compareGrid = document.getElementById('compareGrid');
const compareCount = document.getElementById('compareCount');
let compareSet = new Set();

window.toggleCompare = (adId) => {
  const idStr = String(adId);
  if (compareSet.has(idStr)) compareSet.delete(idStr);
  else compareSet.add(idStr);
  compareCount.textContent = compareSet.size;
};

openCompareModalBtn.addEventListener('click', () => {
  if (compareSet.size === 0) return alert('Sélectionnez au moins 1 annonce avec les cases ☑️ pour comparer.');

  let selectedAds = [];
  allJobsCache.forEach((j) => {
    if (Array.isArray(j.ads)) {
      j.ads.forEach((a) => {
        if (compareSet.has(String(a.id))) selectedAds.push(a);
      });
    }
  });

  compareGrid.innerHTML = selectedAds
    .map((a) => {
      const ma = a.marketAnalysis || {};
      const sign = ma.deltaEur > 0 ? '+' : '';
      return `
      <div class="compare-col">
        <img src="${a.images?.[0] || noPhotoUrl()}" style="width:100%; height:140px; object-fit:cover; border-radius:6px;">
        <strong>${escapeHtml(identifiedName(a))}</strong>
        <div style="font-size:1.2rem; font-weight:bold; color:var(--primary-color);">${a.price} €</div>
        <div style="font-size:0.8rem; color:var(--text-muted);">Valeur marché : ${ma.realValue != null ? ma.realValue + ' €' : '-'}</div>
        <div style="font-size:0.85rem; font-weight:bold; color:var(--green-deal);">Diff. : ${ma.deltaEur != null ? sign + ma.deltaEur + ' €' : '-'}</div>
        <div style="font-size:0.8rem;">Vendeur : ${escapeHtml(a.seller || 'Particulier')}</div>
        <button class="btn btn-primary btn-small" onclick="openUrl('${escapePath(a.url)}')">🔗 Voir Leboncoin</button>
      </div>
    `;
    })
    .join('');

  compareModal.classList.remove('hidden');
});

closeCompareModalBtn.addEventListener('click', () => compareModal.classList.add('hidden'));

// Widget Flottant — fenêtre always-on-top qui affiche la progression du scraping
// Feedback visuel : le bouton bascule en état "actif" tant que le widget est ouvert.
const toggleWidgetBtn = document.getElementById('toggleWidgetBtn');
let widgetActive = false;
toggleWidgetBtn.addEventListener('click', () => {
  window.api.toggleWidget();
  widgetActive = !widgetActive;
  toggleWidgetBtn.classList.toggle('btn-active', widgetActive);
  toggleWidgetBtn.title = widgetActive ? 'Widget flottant ouvert — cliquez pour fermer' : 'Ouvrir le widget flottant';
});

// Modal Paramètres
const openSettingsModalBtn = document.getElementById('openSettingsModalBtn');
const settingsModal = document.getElementById('settingsModal');
const closeSettingsModalBtn = document.getElementById('closeSettingsModalBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const resetSettingsBtn = document.getElementById('resetSettingsBtn');
const cfgTheme = document.getElementById('cfgTheme');
const cfgScrapeSpeed = document.getElementById('cfgScrapeSpeed');
const cfgPageDelay = document.getElementById('cfgPageDelay');
const cfgHeadless = document.getElementById('cfgHeadless');
const cfgAiConcurrency = document.getElementById('cfgAiConcurrency');
const cfgCleanHarDays = document.getElementById('cfgCleanHarDays');
const cfgAutoCleanJobs = document.getElementById('cfgAutoCleanJobs');
const cfgAutoCleanJobsDays = document.getElementById('cfgAutoCleanJobsDays');
const cfgLogRetention = document.getElementById('cfgLogRetention');

function applySettingsToUI(cfg) {
  cfgTheme.value = localStorage.getItem('app-theme') || cfg.theme || 'theme-dark';
  cfgScrapeSpeed.value = cfg.scrapeSpeed || 'fast';
  cfgPageDelay.value = cfg.pageDelayMs ?? 1000;
  cfgHeadless.checked = cfg.headless !== false;
  cfgAiConcurrency.value = cfg.aiConcurrency ?? 5;
  cfgCleanHarDays.value = cfg.autoCleanHarDays || 7;
  const jobsDays = cfg.autoCleanJobsDays || 0;
  cfgAutoCleanJobs.checked = jobsDays > 0;
  cfgAutoCleanJobsDays.value = jobsDays > 0 ? jobsDays : 30;
  cfgAutoCleanJobsDays.disabled = !cfgAutoCleanJobs.checked;
  cfgLogRetention.value = cfg.logRetentionDays || 7;
}

// Active/désactive le champ "jours" selon la checkbox
cfgAutoCleanJobs.addEventListener('change', () => {
  cfgAutoCleanJobsDays.disabled = !cfgAutoCleanJobs.checked;
});

openSettingsModalBtn.addEventListener('click', async () => {
  const cfg = await window.api.getConfig();
  applySettingsToUI(cfg);
  settingsModal.classList.remove('hidden');
});

closeSettingsModalBtn.addEventListener('click', () => settingsModal.classList.add('hidden'));

// Aperçu du thème en temps réel quand on change dans la modale
cfgTheme.addEventListener('change', () => {
  document.body.className = cfgTheme.value;
});

saveSettingsBtn.addEventListener('click', async () => {
  const theme = cfgTheme.value;
  localStorage.setItem('app-theme', theme);
  document.body.className = theme;

  await window.api.saveConfig({
    scrapeSpeed: cfgScrapeSpeed.value,
    pageDelayMs: parseInt(cfgPageDelay.value, 10) || 1000,
    headless: cfgHeadless.checked,
    aiConcurrency: parseInt(cfgAiConcurrency.value, 10) || 5,
    autoCleanHarDays: parseInt(cfgCleanHarDays.value, 10) || 7,
    autoCleanJobsDays: cfgAutoCleanJobs.checked ? (parseInt(cfgAutoCleanJobsDays.value, 10) || 30) : 0,
    logRetentionDays: parseInt(cfgLogRetention.value, 10) || 7,
  });
  settingsModal.classList.add('hidden');
  alert('Paramètres enregistrés avec succès !');
});

resetSettingsBtn.addEventListener('click', async () => {
  if (!confirm('Réinitialiser tous les paramètres aux valeurs par défaut ?')) return;
  localStorage.setItem('app-theme', 'theme-dark');
  document.body.className = 'theme-dark';
  await window.api.saveConfig({
    scrapeSpeed: 'fast',
    pageDelayMs: 1000,
    headless: true,
    aiConcurrency: 5,
    autoCleanHarDays: 7,
    autoCleanJobsDays: 0,
    logRetentionDays: 7,
  });
  applySettingsToUI({ scrapeSpeed: 'fast', pageDelayMs: 1000, headless: true, aiConcurrency: 5, autoCleanHarDays: 7, autoCleanJobsDays: 0, logRetentionDays: 7 });
  alert('Paramètres réinitialisés.');
});

// Modal Suppression & Detail
const confirmModal = document.getElementById('confirmModal');
const modalMessage = document.getElementById('modalMessage');
const modalCancelBtn = document.getElementById('modalCancelBtn');
const modalConfirmBtn = document.getElementById('modalConfirmBtn');

const adDetailModal = document.getElementById('adDetailModal');
const closeDetailModalBtn = document.getElementById('closeDetailModalBtn');
const modalAdTitle = document.getElementById('modalAdTitle');
const mainGalleryImg = document.getElementById('mainGalleryImg');
const galleryThumbnails = document.getElementById('galleryThumbnails');
const modalDealBadge = document.getElementById('modalDealBadge');
const modalStarBtn = document.getElementById('modalStarBtn');
const modalPrice = document.getElementById('modalPrice');
const modalMarketRange = document.getElementById('modalMarketRange');
const modalMarketAvg = document.getElementById('modalMarketAvg');
const modalResellMargin = document.getElementById('modalResellMargin');
const modalCity = document.getElementById('modalCity');
const modalSeller = document.getElementById('modalSeller');
const modalDate = document.getElementById('modalDate');
const modalSummary = document.getElementById('modalSummary');
const modalVisionCard = document.getElementById('modalVisionCard');
const modalVisionContent = document.getElementById('modalVisionContent');
const modalDescription = document.getElementById('modalDescription');
const modalOpenLeboncoinBtn = document.getElementById('modalOpenLeboncoinBtn');

// ─── Helpers de rendu IA (nouveau système : Analyse + Marché) ───────────────
// Centralisent l'affichage des résultats des IA 1 (adAnalysis) et 2 (marketAnalysis)
// pour éviter la duplication entre tableau, grille, comparateur et fiche détaillée.

/**
 * Renvoie un badge HTML pour le verdict de l'IA Marché (bénéfice/perte en €).
 * Plus de score/100 ni de scam score : uniquement la différence de prix.
 */
function renderMarketBadge(ma) {
  if (!ma || ma._fallback || ma.verdict == null) {
    return `<span class="tag-deal-normal">Marché non analysé</span>`;
  }
  const label = ma.verdictLabel || 'Prix correct';
  const delta = ma.deltaEur;
  const sign = delta > 0 ? '+' : '';
  if (label === 'Très bonne affaire') return `<span class="tag-deal-super">🟢🟢 Très bonne affaire (${sign}${delta} €)</span>`;
  if (label === 'Bonne affaire') return `<span class="tag-deal-good">🟢 Bonne affaire (${sign}${delta} €)</span>`;
  if (label === 'Très cher') return `<span class="tag-deal-superhigh">🔴 Trop cher (${sign}${delta} €)</span>`;
  if (label === 'Trop cher') return `<span class="tag-deal-superhigh">🔴 Trop cher (${sign}${delta} €)</span>`;
  return `<span class="tag-deal-normal">${label} (${sign}${delta} €)</span>`;
}

/** Nom identifié par l'IA Analyse (fallback sur le titre si absent). */
function identifiedName(a) {
  const aa = a.adAnalysis;
  if (aa && aa.identifiedProduct && !aa._fallback) return aa.identifiedProduct;
  return a.title || 'Sans titre';
}

/** Résumé court produit par l'IA Analyse (fallback sur la description). */
function analysisSummary(a) {
  const aa = a.adAnalysis;
  if (aa && aa.summary && !aa._fallback) return aa.summary;
  return (a.description || '').slice(0, 120) || 'Aucun résumé IA disponible.';
}

/** Bénéfice/perte lisible (€) issu de l'IA Marché. */
function marketDeltaText(ma) {
  if (!ma || ma._fallback || ma.deltaEur == null) return '-';
  const sign = ma.deltaEur > 0 ? '+' : '';
  const color = ma.deltaEur >= 0 ? 'var(--green-deal)' : 'var(--text-muted)';
  return `<strong style="color:${color};">${sign}${ma.deltaEur} €</strong>`;
}

/** Valeur réelle estimée (€) issue de l'IA Marché. */
function marketValueText(ma) {
  if (!ma || ma._fallback || ma.realValue == null) return '<small style="color:var(--text-muted);">Non estimé</small>';
  let txt = `<strong>${ma.realValue} €</strong>`;
  if (ma.valueRangeLow != null && ma.valueRangeHigh != null) {
    txt += `<br><small style="color:var(--text-muted);">${ma.valueRangeLow} € - ${ma.valueRangeHigh} €</small>`;
  }
  return txt;
}

/** Filtre les annonces par verdict (pour le filtre tag de l'Explorateur). */
function matchesVerdictFilter(a, tagFilter) {
  if (tagFilter === 'FAV') return starredAds.has(String(a.id));
  const v = a.marketAnalysis && a.marketAnalysis.verdictLabel;
  if (tagFilter === 'SUPER') return v === 'Très bonne affaire';
  if (tagFilter === 'GOOD') return v === 'Bonne affaire' || v === 'Très bonne affaire';
  if (tagFilter === 'HIGH') return v === 'Trop cher' || v === 'Très cher';
  return true;
}

let allJobsCache = [];
let priceDistChartInstance = null;
let sellerChartInstance = null;
let topCitiesChartInstance = null;
let mapInstance = null;
let pendingDeleteJobId = null;
let isConfirming = false;

// État de la vue (Tableau vs Galerie) & Favoris
let viewMode = localStorage.getItem('explorer-view') || 'table';
let starredAds = new Set(JSON.parse(localStorage.getItem('starred-ads') || '[]'));

// BASCULE DE VUE TABLEAU / GALERIE
viewTableBtn.addEventListener('click', () => {
  viewMode = 'table';
  localStorage.setItem('explorer-view', 'table');
  viewTableBtn.classList.add('active');
  viewGridBtn.classList.remove('active');
  adsTableContainer.classList.remove('hidden');
  adsGridContainer.classList.add('hidden');
  renderExplorerAds();
});

viewGridBtn.addEventListener('click', () => {
  viewMode = 'grid';
  localStorage.setItem('explorer-view', 'grid');
  viewGridBtn.classList.add('active');
  viewTableBtn.classList.remove('active');
  adsTableContainer.classList.add('hidden');
  adsGridContainer.classList.remove('hidden');
  renderExplorerAds();
});

if (viewMode === 'grid') viewGridBtn.click();

// Start / Stop
startBtn.addEventListener('click', () => {
  if (isOffline) {
    alert('📶 Mode hors-ligne actif. Vous pouvez consulter les jobs déjà scrapés dans l\'onglet Historique, mais le scraping nécessite une connexion à Leboncoin.');
    return;
  }
  const searchUrl = document.getElementById('searchUrl').value.trim();
  if (!searchUrl) {
    alert('Veuillez entrer une URL de recherche Leboncoin valide.');
    return;
  }

  const config = {
    searchUrl,
    pages: document.getElementById('pages').value,
    limit: document.getElementById('limit').value,
    noDesc: document.getElementById('noDesc').checked,
    autoAiMarket: autoAiMarket.checked,
    analyzeImages: analyzeImages.checked,
    proxyUrl: proxyUrl.value.trim() || undefined,
    aiConfig: {
      provider: aiProvider.value,
      model: aiModelName.value.trim() || 'llama3',
      visionModel: localStorage.getItem('ai-vision-model') || 'llava',
      apiKey: getAiApiKey(),
    },
  };

  startBtn.disabled = true;
  stopBtn.disabled = false;
  progressBar.style.width = '0%';
  statusText.textContent = 'Statut : Lancement...';

  window.api.startScraping(config);
});

stopBtn.addEventListener('click', () => {
  window.api.stopScraping();
  stopBtn.disabled = true;
});

triggerMarketBtn.addEventListener('click', async () => {
  const jobId = sessionSelect.value;
  if (!jobId) {
    alert('Veuillez sélectionner un scraping dans le menu déroulant de l\'Explorateur avant de lancer l\'analyse de marché.');
    return;
  }
  triggerMarketBtn.disabled = true;
  progressBar.style.width = '0%';
  statusText.textContent = 'Analyse de marché IA (recherche Internet + estimation)...';

  try {
    // adIds : si des annonces sont sélectionnées pour comparaison, on analyse
    // ciblée celles-là ; sinon on analyse tout le job.
    const adIds = compareSet.size > 0 ? [...compareSet].map(String) : undefined;
    await window.api.analyzeMarket({
      jobId,
      adIds,
      aiConfig: {
        provider: aiProvider.value,
        model: aiModelName.value.trim() || 'llama3',
        visionModel: localStorage.getItem('ai-vision-model') || 'llava',
        apiKey: getAiApiKey(),
      },
      searchConfig: {
        provider: (searchProviderSelect && searchProviderSelect.value) || 'duckduckgo',
        apiKey: getSearchApiKey(),
      },
    });

    await loadExplorerPage();
    // Le handler market:analyze envoie un état 'processing' mais jamais
    // 'completed' (action manuelle via invoke, pas le cycle job:start) :
    // on réinitialise explicitement le statut pour éviter un message
    // « Analyse de marché… » qui reste affiché indéfiniment.
    progressBar.style.width = '100%';
    statusText.textContent = 'Statut : Analyse de marché terminée.';
  } catch (err) {
    statusText.textContent = 'Statut : Échec de l\'analyse de marché.';
    alert(`Erreur d'analyse : ${err.message}`);
  } finally {
    triggerMarketBtn.disabled = false;
  }
});

window.api.onLog(({ level, message }) => {
  const line = document.createElement('div');
  line.className = `log-${level || 'info'}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logsConsole.appendChild(line);
  logsConsole.scrollTop = logsConsole.scrollHeight;

  // Plafond de lignes pour éviter la fuite de mémoire DOM sur les longues sessions
  const MAX_LOG_LINES = 1000;
  while (logsConsole.childElementCount > MAX_LOG_LINES) {
    logsConsole.removeChild(logsConsole.firstChild);
  }
});

window.api.onProgress(({ percent, status, eta }) => {
  if (percent !== undefined) progressBar.style.width = `${percent}%`;
  if (status) statusText.textContent = `Statut : ${status}`;
  if (eta) etaText.textContent = `ETA : ${eta}`;
  else etaText.textContent = '';
  // Transmet au widget flottant (si ouvert)
  if (typeof window.api.sendWidgetProgress === 'function') {
    window.api.sendWidgetProgress({ percent, status });
  }
});

window.api.onStatusChange(({ state, message }) => {
  if (message) statusText.textContent = `Statut : ${message}`;

  if (state === 'completed' || state === 'error') {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    progressBar.style.width = '100%';
    etaText.textContent = '';
  }
  // Transmet au widget flottant (si ouvert)
  if (typeof window.api.sendWidgetStatus === 'function') {
    window.api.sendWidgetStatus({ state, message });
  }
});

// PAGE 3 : HISTORIQUE
async function loadHistoryPage() {
  try {
    allJobsCache = await window.api.getHistory();
    renderHistoryTable(allJobsCache);
  } catch (err) {
    historyTableBody.innerHTML = `<tr><td colspan="4" class="text-center">Erreur : ${err.message}</td></tr>`;
  }
}

function renderHistoryTable(jobs) {
  if (!jobs || jobs.length === 0) {
    historyTableBody.innerHTML = '<tr><td colspan="4" class="text-center">Aucun scraping trouvé dans output/jobs/</td></tr>';
    return;
  }

  historyTableBody.innerHTML = jobs
    .map(
      (j) => `
    <tr>
      <td>${j.date}</td>
      <td><strong>${j.adsCount}</strong> annonces</td>
      <td>
        <div class="file-tags">
          ${j.files.xlsx ? `<span class="file-tag tag-xlsx" onclick="openFile('${escapePath(j.files.xlsx)}')">XLSX</span>` : ''}
          ${j.files.json ? `<span class="file-tag" onclick="openFile('${escapePath(j.files.json)}')">JSON</span>` : ''}

          ${j.files.resumes ? `<span class="file-tag" onclick="openFile('${escapePath(j.files.resumes)}')">RÉSUMÉS IA</span>` : ''}
          ${j.files.txt ? `<span class="file-tag" onclick="openFile('${escapePath(j.files.txt)}')">TXT</span>` : ''}
        </div>
      </td>
      <td>
        <div style="display:flex; gap:6px;">
          <button class="btn btn-secondary btn-small" onclick="openFolder('${escapePath(j.jobDir)}')">📁 Ouvrir</button>
          <button class="btn btn-danger btn-small" onclick="askDeleteJob('${j.id}')">🗑️ Supprimer</button>
        </div>
      </td>
    </tr>
  `
    )
    .join('');
}

// PAGE 4 : EXPLORATEUR D'ANNONCES
async function loadExplorerPage() {
  allJobsCache = await window.api.getHistory();
  populateSessionDropdown(sessionSelect);
  restoreExplorerFilters();
  renderExplorerAds();
}

function populateSessionDropdown(selectEl) {
  const selectedVal = selectEl.value;
  selectEl.innerHTML = '<option value="ALL">🌐 Tous les scrapings combinés (Recherche globale)</option>';

  allJobsCache.forEach((j) => {
    const opt = document.createElement('option');
    opt.value = j.id;
    opt.textContent = `📅 Session du ${j.date} (${j.adsCount} annonces)`;
    selectEl.appendChild(opt);
  });

  if (selectedVal) selectEl.value = selectedVal;
}

// Écouteurs de filtrage sécurisés (Évitent tout plantage en cas d'élément absent)
if (filterKeyword) filterKeyword.addEventListener('input', () => { saveExplorerFilters(); renderExplorerAds(); });
if (filterPriceMin) filterPriceMin.addEventListener('input', () => { saveExplorerFilters(); renderExplorerAds(); });
if (filterPriceMax) filterPriceMax.addEventListener('input', () => { saveExplorerFilters(); renderExplorerAds(); });
if (filterTagSelect) filterTagSelect.addEventListener('change', () => { saveExplorerFilters(); renderExplorerAds(); });
if (sortSelect) sortSelect.addEventListener('change', () => { saveExplorerFilters(); renderExplorerAds(); });

// Changement de session : rafraîchit immédiatement tout l'explorateur (sans
// avoir à manipuler un autre filtre pour déclencher la mise à jour).
if (sessionSelect) sessionSelect.addEventListener('change', () => { renderExplorerAds(); });

// Sauvegarde / restauration des filtres entre les sessions
function saveExplorerFilters() {
  try {
    localStorage.setItem('explorer-filters', JSON.stringify({
      keyword: filterKeyword?.value || '',
      priceMin: filterPriceMin?.value || '',
      priceMax: filterPriceMax?.value || '',
      tag: filterTagSelect?.value || 'ALL',
      sort: sortSelect?.value || 'date-desc',
    }));
  } catch { /* quota dépassé */ }
}

function restoreExplorerFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem('explorer-filters') || '{}');
    if (saved.keyword && filterKeyword) filterKeyword.value = saved.keyword;
    if (saved.priceMin != null && filterPriceMin) filterPriceMin.value = saved.priceMin;
    if (saved.priceMax != null && filterPriceMax) filterPriceMax.value = saved.priceMax;
    if (saved.tag && filterTagSelect) filterTagSelect.value = saved.tag;
    if (saved.sort && sortSelect) sortSelect.value = saved.sort;
  } catch { /* JSON corrompu */ }
}

function renderExplorerAds() {
  const selectedJobId = sessionSelect.value;
  const query = filterKeyword.value.toLowerCase().trim();
  const tagFilter = filterTagSelect.value;
  const sortMode = sortSelect.value;

  const minP = parseFloat(filterPriceMin.value) || 0;
  const maxP = parseFloat(filterPriceMax.value) || Infinity;

  let sourceAds = [];

  if (selectedJobId === 'ALL') {
    allJobsCache.forEach((j) => {
      if (Array.isArray(j.ads)) sourceAds.push(...j.ads);
    });
  } else {
    const found = allJobsCache.find((j) => j.id === selectedJobId);
    if (found && Array.isArray(found.ads)) sourceAds = found.ads;
  }

  let filtered = sourceAds.filter((a) => {
    const fullText = `${a.title || ''} ${a.description || ''} ${a.city || ''} ${a.seller || ''}`.toLowerCase();
    const matchesQuery = !query || fullText.includes(query);

    const price = typeof a.price === 'number' ? a.price : parseFloat(a.price) || 0;
    const matchesPrice = price >= minP && price <= maxP;

    const matchesTag = matchesVerdictFilter(a, tagFilter);

    return matchesQuery && matchesPrice && matchesTag;
  });

  if (sortMode === 'DEAL_DESC') {
    filtered.sort((a, b) => (b.marketAnalysis?.deltaEur ?? -Infinity) - (a.marketAnalysis?.deltaEur ?? -Infinity));
  } else if (sortMode === 'PRICE_ASC') {
    filtered.sort((a, b) => (a.price || 0) - (b.price || 0));
  } else if (sortMode === 'PRICE_DESC') {
    filtered.sort((a, b) => (b.price || 0) - (a.price || 0));
  }

  filteredAdsCount.textContent = filtered.length;

  if (filtered.length === 0) {
    adsTableBody.innerHTML = '<tr><td colspan="9" class="text-center">Aucune annonce ne correspond à votre recherche</td></tr>';
    adsGridContainer.innerHTML = '<div class="text-center" style="grid-column:1/-1;">Aucune annonce ne correspond à votre recherche</div>';
    return;
  }

  if (viewMode === 'table') {
    adsTableBody.innerHTML = filtered
      .map((a) => {
        const ma = a.marketAnalysis || {};
        const badgeHtml = renderMarketBadge(ma);

        const isStarred = starredAds.has(String(a.id));
        const starIcon = `<span class="star-icon ${isStarred ? 'starred' : ''}" onclick="toggleStar('${a.id}')">★</span>`;
        const isChecked = compareSet.has(String(a.id));

        const nameHtml = (a.adAnalysis && !a.adAnalysis._fallback && a.adAnalysis.identifiedProduct)
          ? `<strong>${escapeHtml(a.adAnalysis.identifiedProduct)}</strong><br><small style="color:var(--text-muted);">${escapeHtml(a.title)}</small>`
          : escapeHtml(a.title || 'Sans titre');
        const valueHtml = marketValueText(ma);
        const deltaHtml = marketDeltaText(ma);
        const summaryHtml = `<div class="desc-tooltip" title="${escapeHtml(analysisSummary(a))}">${escapeHtml(analysisSummary(a))}</div>`;


        return `
        <tr>
          <td class="text-center"><input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleCompare('${a.id}')"></td>
          <td class="text-center">${starIcon}</td>
          <td>${nameHtml}</td>
          <td><strong>${a.price != null ? a.price + ' €' : '-'}</strong></td>
          <td>${valueHtml}</td>
          <td>${deltaHtml}</td>
          <td>${badgeHtml}</td>
          <td>${summaryHtml}</td>
          <td>
            <div style="display:flex; gap:4px;">
              <button class="btn btn-secondary btn-small" onclick="openAdDetail('${a.id}')">👁️ Fiche</button>
              <button class="btn btn-secondary btn-small" onclick="openUrl('${escapePath(a.url)}')">🔗</button>
            </div>
          </td>
        </tr>
      `;
      })
      .join('');
  }

  if (viewMode === 'grid') {
    adsGridContainer.innerHTML = filtered
      .map((a) => {
        const ma = a.marketAnalysis || {};
        const badgeHtml = renderMarketBadge(ma);

        const isStarred = starredAds.has(String(a.id));
        const thumbUrl = Array.isArray(a.images) && a.images.length > 0 ? a.images[0] : noPhotoUrl();

        return `
        <div class="ad-card">
          <div class="ad-card-thumb-box">
            <img src="${thumbUrl}" alt="Photo" class="ad-card-thumb" onclick="openAdDetail('${a.id}')">
            <div class="ad-card-badge-box">${badgeHtml}</div>
            <div class="ad-card-star"><span class="star-icon ${isStarred ? 'starred' : ''}" onclick="toggleStar('${a.id}')">★</span></div>
          </div>
          <div class="ad-card-body">
            <div class="ad-card-title">${escapeHtml(identifiedName(a))}</div>
            <div class="ad-card-price">${a.price != null ? a.price + ' €' : '-'}</div>
            <div class="ad-card-city">📍 ${escapeHtml(a.city || 'Inconnue')}</div>
            <div class="ad-card-footer">
              <button class="btn btn-secondary btn-small" style="flex:1;" onclick="openAdDetail('${a.id}')">👁️ Fiche Détaillée</button>
              <button class="btn btn-primary btn-small" onclick="openUrl('${escapePath(a.url)}')">🔗 Voir</button>
            </div>
          </div>
        </div>
      `;
      })
      .join('');
  }
}

// ⭐ SYSTÈME DE FAVORIS
window.toggleStar = (adId) => {
  const idStr = String(adId);
  if (starredAds.has(idStr)) starredAds.delete(idStr);
  else starredAds.add(idStr);

  localStorage.setItem('starred-ads', JSON.stringify([...starredAds]));
  renderExplorerAds();
};

// 👁️ MODAL FICHE DÉTAILLÉE DE L'ANNONCE
window.openAdDetail = (adId) => {
  let targetAd = null;
  allJobsCache.forEach((j) => {
    if (Array.isArray(j.ads)) {
      const found = j.ads.find((a) => String(a.id) === String(adId));
      if (found) targetAd = found;
    }
  });

  if (!targetAd) return;

  const ma = targetAd.marketAnalysis || {};
  const aa = targetAd.adAnalysis || {};
  modalAdTitle.textContent = identifiedName(targetAd);
  modalPrice.textContent = targetAd.price != null ? targetAd.price : '-';
  modalMarketAvg.textContent = ma.realValue != null ? `${ma.realValue} €` : '-';
  modalMarketRange.textContent = (ma.valueRangeLow != null && ma.valueRangeHigh != null)
    ? `${ma.valueRangeLow} € - ${ma.valueRangeHigh} €`
    : 'Non estimé';
  modalResellMargin.textContent = ma.deltaEur != null
    ? `${ma.deltaEur > 0 ? '+' : ''}${ma.deltaEur} € (${ma.verdictLabel || '—'})`
    : '-';
  modalCity.textContent = targetAd.city || 'Inconnue';
  modalSeller.textContent = `${targetAd.seller || 'Particulier'}${targetAd.isPro ? ' (Pro)' : ''}`;
  modalDate.textContent = targetAd.date || '-';

  // Nouveaux champs : catégorie, note vendeur, mode de remise
  const setExtraVal = (spanId, text) => {
    const span = document.getElementById(spanId);
    if (span) {
      const valEl = span.querySelector('.modal-extra-val');
      if (valEl) valEl.textContent = text;
    }
  };

  setExtraVal('modalCategory', targetAd.category || 'Non précisée');

  let ratingText = '-';
  if (targetAd.sellerRating != null) {
    ratingText = `${targetAd.sellerRating}/5`;
    if (targetAd.sellerRatingCount != null) ratingText += ` (${targetAd.sellerRatingCount} avis)`;
  }
  setExtraVal('modalSellerRating', targetAd.sellerRating != null ? ratingText : 'Aucune note');

  const deliveryLabels = {
    livraison: '📦 Livraison',
    main_propre: '🤝 Main propre',
    inconnu: 'ℹ️ Non précisée',
  };
  let deliveryText = deliveryLabels[targetAd.deliveryMode] || 'ℹ️ Non précisée';
  if (targetAd.deliveryLabel && targetAd.deliveryMode === 'livraison') {
    deliveryText += ` — ${targetAd.deliveryLabel}`;
  }
  setExtraVal('modalDeliveryMode', deliveryText);
  // Résumé IA : combine le résumé de l'IA Analyse (ce qu'est l'objet) et la
  // rationale de l'IA Marché (pourquoi cette estimation en €).
  let summaryText = aa.summary || '';
  if (ma.rationale && !ma._fallback) {
    summaryText = summaryText ? `${summaryText}\n\n💰 ${ma.rationale}` : `💰 ${ma.rationale}`;
  }
  if (Array.isArray(ma.sources) && ma.sources.length > 0) {
    const srcTxt = ma.sources.slice(0, 3).map((s) => s.title || s.url || s).join(' · ');
    summaryText = summaryText ? `${summaryText}\n\nSources marché : ${srcTxt}` : `Sources marché : ${srcTxt}`;
  }
  modalSummary.textContent = summaryText || 'Aucune analyse IA disponible. Lancez « Analyse IA » puis « IA Marché ».';
  modalDescription.textContent = targetAd.description || 'Aucune description disponible.';

  // Analyse visuelle IA : désormais intégrée dans adAnalysis.vision (produite
  // par l'IA Analyse en un seul appel texte+vision). Fallback imageAnalysis
  // pour les jeux de données analysés avec l'ancien système.
  const vision = (targetAd.adAnalysis && targetAd.adAnalysis.vision) || targetAd.imageAnalysis || null;
  if (vision && (vision.photoType || vision.visibleCondition || vision.summary)) {
    const photoTypeLabels = {
      REAL_PRODUCT: '📸 Photo authentique (produit réel)',
      STOCK_PHOTO: '🏢 Photo constructeur/marketing',
      SCREENSHOT: '🖥️ Capture d\'écran',
      UNCLEAR: '❓ Type indéterminé',
    };
    const conditionLabels = {
      NEW: '🆕 Neuf',
      LIKE_NEW: '✨ Comme neuf',
      GOOD: '👍 Bon état',
      WORN: '⚠️ Usé',
      DAMAGED: '🔴 Endommagé',
    };
    const photoType = photoTypeLabels[vision.photoType] || vision.photoType || '-';
    const condition = conditionLabels[vision.visibleCondition] || vision.visibleCondition || '-';
    const defects = Array.isArray(vision.visibleDefects) && vision.visibleDefects.length > 0
      ? vision.visibleDefects.join(', ')
      : 'Aucun défaut visible';
    const authScore = vision.authenticityScore != null ? `${vision.authenticityScore}/100` : '-';
    const authColor = vision.authenticityScore >= 70 ? '#4caf50' : (vision.authenticityScore >= 40 ? '#ff9800' : '#f44336');

    modalVisionContent.innerHTML = `
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:8px;">
        <div><strong>Type photo :</strong><br>${photoType}</div>
        <div><strong>État visible :</strong><br>${condition}</div>
        <div><strong>Défauts :</strong><br>${defects}</div>
        <div><strong>Authenticité :</strong><br><span style="color:${authColor}; font-weight:bold;">${authScore}</span></div>
      </div>
      <div style="padding:8px; background:var(--bg-secondary); border-radius:6px; margin-top:6px;">
        💬 ${vision.summary || vision.visionSummary || 'Aucun résumé visuel disponible.'}
      </div>
    `;
    modalVisionCard.classList.remove('hidden');
  } else {
    modalVisionCard.classList.add('hidden');
  }

  // Badge verdict IA Marché (bénéfice/perte en € — plus de score ni de %)
  if (ma && !ma._fallback && ma.verdictLabel) {
    const cls = ma.verdictLabel === 'Très bonne affaire' ? 'tag-deal-super'
      : ma.verdictLabel === 'Bonne affaire' ? 'tag-deal-good'
      : (ma.verdictLabel === 'Trop cher' || ma.verdictLabel === 'Très cher') ? 'tag-deal-superhigh'
      : 'tag-deal-normal';
    modalDealBadge.className = cls;
    const sign = ma.deltaEur > 0 ? '+' : '';
    modalDealBadge.textContent = `${ma.verdictLabel} (${sign}${ma.deltaEur != null ? ma.deltaEur : '?'} €)`;
  } else {
    modalDealBadge.className = 'tag-deal-normal';
    modalDealBadge.textContent = 'Marché non analysé';
  }

  // Photos & Carrousel
  const images = Array.isArray(targetAd.images) && targetAd.images.length > 0 ? targetAd.images : [noPhotoUrl()];
  mainGalleryImg.src = images[0];

  galleryThumbnails.innerHTML = images
    .map(
      (img, i) => `<img src="${img}" alt="Thumb" class="thumb-img ${i === 0 ? 'active' : ''}" onclick="switchGalleryImg('${img}', this)">`
    )
    .join('');

  window.switchGalleryImg = (url, el) => {
    mainGalleryImg.src = url;
    document.querySelectorAll('.thumb-img').forEach((t) => t.classList.remove('active'));
    el.classList.add('active');
  };

  modalOpenLeboncoinBtn.onclick = () => window.openUrl(targetAd.url);

  const isStarred = starredAds.has(String(targetAd.id));
  modalStarBtn.textContent = isStarred ? '⭐ Enlevé des Favoris' : '☆ Ajouter aux Favoris';
  modalStarBtn.onclick = () => {
    window.toggleStar(targetAd.id);
    window.openAdDetail(targetAd.id);
  };

  adDetailModal.classList.remove('hidden');
};

closeDetailModalBtn.addEventListener('click', () => {
  adDetailModal.classList.add('hidden');
});

// PAGE STATISTIQUES & CARTE LEAFLET
async function loadStatsPage() {
  allJobsCache = await window.api.getHistory();
  populateSessionDropdown(statsSessionSelect);
  renderStatsView();
}

statsSessionSelect.addEventListener('change', renderStatsView);

function renderStatsView() {
  const selectedJobId = statsSessionSelect.value;
  let sourceAds = [];

  if (selectedJobId === 'ALL') {
    allJobsCache.forEach((j) => {
      if (Array.isArray(j.ads)) sourceAds.push(...j.ads);
    });
  } else {
    const found = allJobsCache.find((j) => j.id === selectedJobId);
    if (found && Array.isArray(found.ads)) sourceAds = found.ads;
  }

  const prices = sourceAds.map((a) => Number(a.price)).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('fr-FR') : '-');

  statTotalAds.textContent = sourceAds.length;

  if (prices.length > 0) {
    const sum = prices.reduce((s, p) => s + p, 0);
    const avg = Math.round(sum / prices.length);
    const median = prices.length % 2 ? prices[(prices.length - 1) / 2] : Math.round((prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2);
    statAvgPrice.textContent = fmt(avg) + ' €';
    statMedPrice.textContent = fmt(median) + ' €';
    statMinPrice.textContent = fmt(prices[0]) + ' €';
    statMaxPrice.textContent = fmt(prices[prices.length - 1]) + ' €';
  } else {
    statAvgPrice.textContent = '-'; statMedPrice.textContent = '-'; statMinPrice.textContent = '-'; statMaxPrice.textContent = '-';
  }

  // « Remise en main propre » = livraison explicitement indisponible
  // (shipping === false). On n'utilise PAS !a.shipping car shipping=null
  // (info non extraite, p. ex. en mode ultra-rapide) serait compté à tort
  // comme une remise en main propre.
  const handCount = sourceAds.filter((a) => a.shipping === false).length;
  const proCount = sourceAds.filter((a) => a.isPro).length;
  const partCount = sourceAds.length - proCount;

  statHandDelivery.textContent = fmt(handCount);
  statPro.textContent = fmt(proCount);
  statPart.textContent = fmt(partCount);

  renderCharts(sourceAds);
  renderMap(sourceAds);
}

// 🗺️ NOUVEAU : Géocodeur officiel API Gouv France avec Cache Local (LocalStorage)
async function geocodeCityGov(cityName, zipcode) {
  if (!cityName) return null;
  const cleanCity = cityName.toLowerCase().trim();
  const cacheKey = `geo-cache-${cleanCity}-${zipcode || ''}`;
  
  // Lecture du cache local
  const cached = localStorage.getItem(cacheKey);
  if (cached) return JSON.parse(cached);

  try {
    let url = `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(cleanCity)}&fields=centre&limit=1`;
    if (zipcode && /^\d{5}$/.test(zipcode)) {
      url = `https://geo.api.gouv.fr/communes?codePostal=${zipcode}&fields=centre&limit=1`;
    }

    // Timeout : sans AbortController, une API gouv injoignable pouvait bloquer
    // indéfiniment le rendu de la carte (fetch natif n'a pas d'option timeout).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      const data = await res.json();
      if (data && data[0] && data[0].centre) {
        const lngLat = data[0].centre.coordinates; // Format gouv : [longitude, latitude]
        const latLng = [lngLat[1], lngLat[0]]; // Format Leaflet : [latitude, longitude]
        
        localStorage.setItem(cacheKey, JSON.stringify(latLng)); // Sauvegarde cache
        return latLng;
      }
    }
  } catch (err) {
    console.warn(`[Geocoding API Gouv] Échec pour la ville ${cityName} :`, err.message);
  }
  return null;
}

// 🗺️ CARTE INTERACTIVE LEAFLET AVEC FILTRAGE MAIN PROPRE ET API GOUV (SUR SAUVEGARDE PROPRE)
async function renderMap(ads) {
  if (typeof L === 'undefined') return;

  try {
    if (!mapInstance) {
      mapInstance = L.map('leafletMap').setView([46.603354, 1.888334], 5);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '© OpenStreetMap',
      }).addTo(mapInstance);
    }

    // Effacer les anciens marqueurs de la carte
    mapInstance.eachLayer((layer) => {
      if (layer instanceof L.Marker) mapInstance.removeLayer(layer);
    });

    const mapHandDeliveryOnly = document.getElementById('mapHandDeliveryOnly').checked;

    // Déduplication : une même annonce peut apparaître dans plusieurs sessions
    // de scraping (ex. « tous les scrapings combinés »). On ne l'affiche qu'une
    // seule fois sur la carte, identifiée par son id Leboncoin (fiable).
    const seenIds = new Set();
    const dedupedAds = [];
    for (const a of ads) {
      const key = a.id || a.url || a.title;
      if (!key || !seenIds.has(key)) {
        if (key) seenIds.add(key);
        dedupedAds.push(a);
      }
    }

    // Filtrer les annonces "main propre" uniquement (shipping === false,
    // pas null qui signifie « info non extraite »).
    let targetAds = dedupedAds;
    if (mapHandDeliveryOnly) {
      targetAds = dedupedAds.filter((a) => a.shipping === false);
      console.log(`[Carte] Filtre main propre ON : ${targetAds.length}/${dedupedAds.length} annonces (shipping=false uniquement) — ${ads.length - dedupedAds.length} doublon(s) supprimé(s)`);
    } else {
      console.log(`[Carte] Filtre main propre OFF : ${dedupedAds.length} annonces affichées — ${ads.length - dedupedAds.length} doublon(s) supprimé(s)`);
    }

    // Géocodage à concurrence limitée (au lieu d'un await séquentiel qui
    // pouvait prendre plusieurs minutes pour 100+ annonces). On borne à 6
    // requêtes parallèles pour rester dans les limites de l'API Gouv.
    const GEOCODE_CONCURRENCY = 6;
    const queue = [...targetAds];
    const placeMarker = (a, coords) => {
      if (!coords) return;
      const jitterCoords = [
        coords[0] + (Math.random() - 0.5) * 0.012,
        coords[1] + (Math.random() - 0.5) * 0.012
      ];
      const marker = L.marker(jitterCoords).addTo(mapInstance);
      const deliveryTxt = a.deliveryMode === 'livraison'
        ? '📦 Livraison possible'
        : a.deliveryMode === 'main_propre'
          ? '🤝 Remise en main propre'
          : 'ℹ️ Remise non précisée';
      marker.bindPopup(`
        <div style="font-family:sans-serif; font-size:0.8rem; line-height:1.3;">
          <strong>${escapeHtml(a.title)}</strong><br>
          <span style="color:var(--primary-color); font-weight:bold;">${a.price} €</span><br>
          📍 ${escapeHtml(a.city || 'Ville')}<br>
          ${deliveryTxt}${a.category ? '<br>🏷️ ' + escapeHtml(a.category) : ''}<br>
          <a href="#" onclick="openUrl('${escapePath(a.url)}'); return false;" style="color:#38bdf8; text-decoration:underline;">Ouvrir l'annonce</a>
        </div>
      `);
    };

    const worker = async () => {
      while (queue.length > 0) {
        const a = queue.shift();
        if (!a) break;
        try {
          const coords = await geocodeCityGov(a.city, a.zipcode);
          placeMarker(a, coords);
        } catch (err) {
          console.warn(`[Carte] géocodage échoué pour ${a.city || '?'} :`, err.message);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(GEOCODE_CONCURRENCY, targetAds.length) }, () => worker()));
  } catch (err) {
    console.error('[Carte] Erreur lors du rendu de la carte :', err.message);
  }
}


function renderCharts(ads) {
  if (typeof Chart === 'undefined' || ads.length === 0) return;

  // 1) Distribution des prix (histogramme)
  const prices = ads.map((a) => Number(a.price)).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  const priceDistCtx = document.getElementById('priceDistChart').getContext('2d');
  if (priceDistChartInstance) priceDistChartInstance.destroy();

  if (prices.length > 0) {
    const maxPrice = prices[prices.length - 1];
    // Bornes adaptatives : jusqu'à 8 tranches
    const bucketCount = Math.min(8, Math.max(3, Math.ceil(Math.sqrt(prices.length))));
    const bucketSize = Math.max(1, Math.ceil(maxPrice / bucketCount));
    const buckets = new Array(bucketCount).fill(0);
    const labels = [];
    for (let i = 0; i < bucketCount; i++) {
      const lo = i * bucketSize;
      const hi = (i + 1) * bucketSize;
      labels.push(lo === 0 ? `0–${hi} €` : `${lo}–${hi} €`);
    }
    for (const p of prices) {
      let idx = Math.floor(p / bucketSize);
      if (idx >= bucketCount) idx = bucketCount - 1;
      buckets[idx]++;
    }
    priceDistChartInstance = new Chart(priceDistCtx, {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Nombre d\'annonces', data: buckets, backgroundColor: '#38bdf8', borderRadius: 6 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { title: { display: true, text: 'Distribution des Prix' }, legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  }

  // 2) Vendeurs particuliers vs pros
  const proCount = ads.filter((a) => a.isPro).length;
  const partCount = ads.length - proCount;
  const sellerCtx = document.getElementById('sellerChart').getContext('2d');
  if (sellerChartInstance) sellerChartInstance.destroy();

  sellerChartInstance = new Chart(sellerCtx, {
    type: 'doughnut',
    data: {
      labels: ['Particuliers', 'Professionnels'],
      datasets: [{
        data: [partCount, proCount],
        backgroundColor: ['#38bdf8', '#8b5cf6'],
        // Chart.js dessine sur un canvas : les variables CSS ne sont pas
        // résolues et rendent la bordure invisible/noire. On lit la valeur
        // réellement calculée par le navigateur via getComputedStyle.
        borderColor: getComputedStyle(document.body).getPropertyValue('--card-bg').trim() || '#1e293b',
        borderWidth: 3,
        hoverOffset: 8,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        title: { display: true, text: 'Vendeurs Particuliers vs Pros', padding: { bottom: 12 } },
        legend: {
          position: 'bottom',
          labels: { usePointStyle: true, pointStyle: 'circle', padding: 18, boxWidth: 10 },
        },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          padding: 12,
          cornerRadius: 8,
          callbacks: {
            label: (ctx) => {
              const total = partCount + proCount;
              const v = ctx.parsed;
              const pct = total ? Math.round((v / total) * 100) : 0;
              return `${ctx.label}: ${v.toLocaleString('fr-FR')} (${pct}%)`;
            },
          },
        },
      },
    },
  });

  // 3) Top 10 villes par nombre d'annonces
  const cityCounts = {};
  for (const a of ads) {
    const c = (a.city || 'Inconnue').trim() || 'Inconnue';
    cityCounts[c] = (cityCounts[c] || 0) + 1;
  }
  const topCities = Object.entries(cityCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const citiesCtx = document.getElementById('topCitiesChart').getContext('2d');
  if (topCitiesChartInstance) topCitiesChartInstance.destroy();

  topCitiesChartInstance = new Chart(citiesCtx, {
    type: 'bar',
    data: {
      labels: topCities.map((c) => c[0]),
      datasets: [{ label: 'Annonces', data: topCities.map((c) => c[1]), backgroundColor: '#22c55e', borderRadius: 6 }],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { title: { display: true, text: 'Top 10 Villes' }, legend: { display: false } },
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 } },
        // Force l'affichage des 10 labels de villes (autoSkip désactivé, aucun
        // masquage alterné).
        y: { ticks: { autoSkip: false, maxTicksLimit: 10 } },
      },
    },
  });
}

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

function escapePath(pathStr) {
  if (!pathStr) return '';
  return String(pathStr).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

window.openUrl = (urlStr) => {
  if (urlStr) window.api.openExternal(urlStr);
};

window.openFolder = (folderPath) => {
  if (folderPath) window.api.openFolder(folderPath);
};

window.openFile = (filePath) => {
  if (filePath) window.api.openFile(filePath);
};

window.askDeleteJob = (jobId) => {
  pendingDeleteJobId = jobId;
  modalMessage.textContent = `Voulez-vous vraiment supprimer définitivement le scraping "${jobId}" ?`;
  confirmModal.classList.remove('hidden');
};

modalCancelBtn.addEventListener('click', () => {
  confirmModal.classList.add('hidden');
  pendingDeleteJobId = null;
});

modalConfirmBtn.addEventListener('click', async () => {
  if (!pendingDeleteJobId || isConfirming) return;
  const jobId = pendingDeleteJobId;
  isConfirming = true;
  modalConfirmBtn.disabled = true;
  try {
    await window.api.deleteJob(jobId);
    confirmModal.classList.add('hidden');
    pendingDeleteJobId = null;
    await loadHistoryPage();
  } catch (err) {
    console.error('[confirmDelete] Échec suppression :', err);
    confirmModal.classList.add('hidden');
    pendingDeleteJobId = null;
  } finally {
    isConfirming = false;
    modalConfirmBtn.disabled = false;
  }
});

document.getElementById('openMainFolderBtn').addEventListener('click', () => {
  window.api.openFolder('');
});

clearLogsBtn.addEventListener('click', () => {
  logsConsole.innerHTML = '';
});

// Écouteur pour rafraîchir la carte si on coche/décoche la remise en main propre
document.getElementById('mapHandDeliveryOnly').addEventListener('change', () => {
  renderStatsView();
});
