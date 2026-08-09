'use strict';

// 🎨 THÈMES
const themeSelect = document.getElementById('themeSelect');
const savedTheme = localStorage.getItem('app-theme') || 'theme-dark';
document.body.className = savedTheme;
themeSelect.value = savedTheme;

themeSelect.addEventListener('change', (e) => {
  const selectedTheme = e.target.value;
  document.body.className = selectedTheme;
  localStorage.setItem('app-theme', selectedTheme);
});

// ONGLETS
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));

    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');

    if (btn.dataset.tab === 'tab-history') loadHistoryPage();
    if (btn.dataset.tab === 'tab-explorer') loadExplorerPage();
    if (btn.dataset.tab === 'tab-global-ai') loadGlobalAiPage();
    if (btn.dataset.tab === 'tab-scheduler') loadSchedulerPage();
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
  }
});

// Éléments UI Global Gemini
const globalJobSelect = document.getElementById('globalJobSelect');
const globalPresetSelect = document.getElementById('globalPresetSelect');
const geminiApiKey = document.getElementById('geminiApiKey');
const customInstructionGroup = document.getElementById('customInstructionGroup');
const customInstructionText = document.getElementById('customInstructionText');
const startGlobalAiBtn = document.getElementById('startGlobalAiBtn');

const globalReportContainer = document.getElementById('globalReportContainer');
const kpiTotalAnalyzed = document.getElementById('kpiTotalAnalyzed');
const kpiBestDeal = document.getElementById('kpiBestDeal');
const kpiTotalProfit = document.getElementById('kpiTotalProfit');
const kpiOverviewText = document.getElementById('kpiOverviewText');
const rankingCardsBox = document.getElementById('rankingCardsBox');

geminiApiKey.value = localStorage.getItem('gemini-api-key') || '';
geminiApiKey.addEventListener('change', (e) => localStorage.setItem('gemini-api-key', e.target.value));

globalPresetSelect.addEventListener('change', (e) => {
  if (e.target.value === 'CUSTOM') customInstructionGroup.classList.remove('hidden');
  else customInstructionGroup.classList.add('hidden');
});

async function loadGlobalAiPage() {
  allJobsCache = await window.api.getHistory();
  populateSessionDropdown(globalJobSelect);
}

// 🧠 LANCEMENT DE L'ANALYSE GLOBALE GEMINI (1M TOKENS)
startGlobalAiBtn.addEventListener('click', async () => {
  const apiKey = geminiApiKey.value.trim();
  if (!apiKey) {
    alert('Veuillez entrer une clé API gratuite Google AI Studio (aistudio.google.com).');
    return;
  }

  startGlobalAiBtn.disabled = true;
  statusText.textContent = 'Analyse Globale Gemini en cours...';

  try {
    const reportData = await window.api.analyzeGlobalDataset({
      jobId: globalJobSelect.value,
      presetKey: globalPresetSelect.value,
      customInstruction: customInstructionText.value.trim(),
      geminiApiKey: apiKey,
      geminiModel: 'gemini-2.0-flash',
    });

    renderGlobalReport(reportData);
  } catch (err) {
    alert(`Erreur Analyse Globale : ${err.message}`);
  } finally {
    startGlobalAiBtn.disabled = false;
  }
});

function renderGlobalReport(data) {
  if (!data || !data.summaryKpi) return;

  globalReportContainer.classList.remove('hidden');

  kpiTotalAnalyzed.textContent = `${data.summaryKpi.totalAnalyzed || 0} annonces`;
  kpiBestDeal.textContent = data.summaryKpi.bestDealTitle || '-';
  kpiTotalProfit.textContent = `+${data.summaryKpi.totalPotentialProfitEur || 0} €`;
  kpiOverviewText.textContent = data.summaryKpi.overview || 'Analyse terminée.';

  if (Array.isArray(data.topRanking)) {
    rankingCardsBox.innerHTML = data.topRanking
      .map(
        (item) => `
      <div class="rank-card rank-${item.rank}">
        <div class="rank-badge-box">#${item.rank}</div>
        <div class="rank-content">
          <div class="rank-title">${escapeHtml(item.identifiedProduct || 'Annonce')}</div>
          <div class="rank-price-row">
            Prix Demandé : <span class="rank-price">${item.askingPrice} €</span> | 
            Valeur Estimée : <strong>${item.estimatedMarketValue} €</strong> | 
            Marge Revente : <strong style="color:var(--green-deal);">+${item.estimatedNetProfitEur} € (${item.dealDiscountPct}%)</strong>
          </div>
          <div class="rank-reason">💬 <strong>Analyse de l'IA :</strong> ${escapeHtml(item.whyItIsTop)}</div>
        </div>
      </div>
    `
      )
      .join('');
  }
}

// Reste des éléments UI
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusText = document.getElementById('statusText');
const etaText = document.getElementById('etaText');
const progressBar = document.getElementById('progressBar');
const logsConsole = document.getElementById('logsConsole');
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

const statGoodDeals = document.getElementById('statGoodDeals');
const statRisks = document.getElementById('statRisks');
const statTotalAds = document.getElementById('statTotalAds');

// Déclarations de sécurité pour l'historique et la suppression
const openMainFolderBtn = document.getElementById('openMainFolderBtn');

// Scheduler Elements
const schedUrl = document.getElementById('schedUrl');
const schedInterval = document.getElementById('schedInterval');
const addSchedBtn = document.getElementById('addSchedBtn');
const schedTableBody = document.getElementById('schedTableBody');

// Proxy & AI
const proxyUrl = document.getElementById('proxyUrl');
proxyUrl.value = localStorage.getItem('proxy-url') || '';
proxyUrl.addEventListener('change', (e) => localStorage.setItem('proxy-url', e.target.value));

const autoAiMarket = document.getElementById('autoAiMarket');
const aiProvider = document.getElementById('aiProvider');
const aiModelName = document.getElementById('aiModelName');
const aiApiKey = document.getElementById('aiApiKey');
const openAiKeyGroup = document.getElementById('openAiKeyGroup');

aiModelName.value = localStorage.getItem('ai-model-name') || 'llama3';
aiModelName.addEventListener('change', (e) => localStorage.setItem('ai-model-name', e.target.value));

aiApiKey.value = localStorage.getItem('openai-key') || '';
aiApiKey.addEventListener('change', (e) => localStorage.setItem('openai-key', e.target.value));

aiProvider.addEventListener('change', (e) => {
  if (e.target.value === 'openai') openAiKeyGroup.classList.remove('hidden');
  else openAiKeyGroup.classList.add('hidden');
});

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

savePresetBtn.addEventListener('click', () => {
  const url = document.getElementById('searchUrl').value.trim();
  if (!url) return alert('Veuillez entrer une URL de recherche.');
  const name = prompt('Nom du modèle de recherche :', 'Ma Recherche');
  if (name) {
    presets.push({ name, url, pages: document.getElementById('pages').value });
    localStorage.setItem('search-presets', JSON.stringify(presets));
    renderPresets();
  }
});

window.loadPreset = (i) => {
  const p = presets[i];
  if (p) {
    document.getElementById('searchUrl').value = p.url;
    document.getElementById('pages').value = p.pages || 2;
  }
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
      return `
      <div class="compare-col">
        <img src="${a.images?.[0] || 'https://via.placeholder.com/200'}" style="width:100%; height:140px; object-fit:cover; border-radius:6px;">
        <strong>${escapeHtml(ma.productName || a.title)}</strong>
        <div style="font-size:1.2rem; font-weight:bold; color:var(--primary-color);">${a.price} €</div>
        <div style="font-size:0.8rem; color:var(--text-muted);">Marché: ${ma.marketAvg || '-'} €</div>
        <div style="font-size:0.85rem; font-weight:bold; color:var(--green-deal);">Marge: ${ma.netMarginEur ? ma.netMarginEur + ' €' : '-'}</div>
        <div style="font-size:0.8rem;">Vendeur: ${escapeHtml(a.seller || 'Particulier')}</div>
        <button class="btn btn-primary btn-small" onclick="openUrl('${escapePath(a.url)}')">🔗 Voir Leboncoin</button>
      </div>
    `;
    })
    .join('');

  compareModal.classList.remove('hidden');
});

closeCompareModalBtn.addEventListener('click', () => compareModal.classList.add('hidden'));

// Widget Flottant — fenêtre always-on-top qui affiche la progression du scraping
document.getElementById('toggleWidgetBtn').addEventListener('click', () => {
  window.api.toggleWidget();
});

// Modal Paramètres
const openSettingsModalBtn = document.getElementById('openSettingsModalBtn');
const settingsModal = document.getElementById('settingsModal');
const closeSettingsModalBtn = document.getElementById('closeSettingsModalBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const cfgCleanHarDays = document.getElementById('cfgCleanHarDays');

openSettingsModalBtn.addEventListener('click', async () => {
  const cfg = await window.api.getConfig();
  cfgCleanHarDays.value = cfg.autoCleanHarDays || 7;
  settingsModal.classList.remove('hidden');
});

closeSettingsModalBtn.addEventListener('click', () => settingsModal.classList.add('hidden'));

saveSettingsBtn.addEventListener('click', async () => {
  await window.api.saveConfig({
    autoCleanHarDays: parseInt(cfgCleanHarDays.value, 10) || 7,
  });
  settingsModal.classList.add('hidden');
  alert('Paramètres enregistrés avec succès !');
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
const modalDescription = document.getElementById('modalDescription');
const modalOpenLeboncoinBtn = document.getElementById('modalOpenLeboncoinBtn');

let allJobsCache = [];
let dealsChartInstance = null;
let sellerChartInstance = null;
let mapInstance = null;
let pendingDeleteJobId = null;

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
    csv: document.getElementById('csv').checked,
    autoAiMarket: autoAiMarket.checked,
    proxyUrl: proxyUrl.value.trim() || undefined,
    aiConfig: {
      provider: aiProvider.value,
      model: aiModelName.value.trim() || 'llama3',
      apiKey: aiApiKey.value,
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
  triggerMarketBtn.disabled = true;
  statusText.textContent = 'Analyse de marché IA en cours...';

  try {
    await window.api.analyzeMarket({
      jobId,
      aiConfig: {
        provider: aiProvider.value,
        model: aiModelName.value.trim() || 'llama3',
        apiKey: aiApiKey.value,
      },
    });

    await loadExplorerPage();
  } catch (err) {
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
          ${j.files.csv ? `<span class="file-tag" onclick="openFile('${escapePath(j.files.csv)}')">CSV</span>` : ''}
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
if (sessionSelect) sessionSelect.addEventListener('change', renderExplorerAds);
if (filterKeyword) filterKeyword.addEventListener('input', renderExplorerAds);
if (filterPriceMin) filterPriceMin.addEventListener('input', renderExplorerAds);
if (filterPriceMax) filterPriceMax.addEventListener('input', renderExplorerAds);
if (filterTagSelect) filterTagSelect.addEventListener('change', renderExplorerAds);
if (sortSelect) sortSelect.addEventListener('change', renderExplorerAds);

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

    let matchesTag = true;
    if (tagFilter === 'FAV') matchesTag = starredAds.has(String(a.id));
    else if (tagFilter === 'SUPER') matchesTag = a.marketAnalysis?.classification === 'Très bonne affaire';
    else if (tagFilter === 'GOOD') matchesTag = a.marketAnalysis?.classification === 'Bonne affaire' || a.marketAnalysis?.classification === 'Très bonne affaire';
    else if (tagFilter === 'HIGH') matchesTag = a.marketAnalysis?.classification === 'Trop cher';

    return matchesQuery && matchesPrice && matchesTag;
  });

  if (sortMode === 'DEAL_DESC') {
    filtered.sort((a, b) => (a.marketAnalysis?.diffPct || 0) - (b.marketAnalysis?.diffPct || 0));
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
        let badgeHtml = `<span class="tag-deal-normal">Prix marché</span>`;

        if (ma.classification === 'Très bonne affaire') {
          badgeHtml = `<span class="tag-deal-super">🟢🟢 Très Bonne Affaire (${ma.diffPct}%)</span>`;
        } else if (ma.classification === 'Bonne affaire') {
          badgeHtml = `<span class="tag-deal-good">🟢 Bonne Affaire (${ma.diffPct}%)</span>`;
        } else if (ma.classification === 'Légèrement cher') {
          badgeHtml = `<span class="tag-deal-high">🟡 Légèrement cher (+${ma.diffPct}%)</span>`;
        } else if (ma.classification === 'Trop cher') {
          badgeHtml = `<span class="tag-deal-superhigh">🔴 Trop cher (+${ma.diffPct}%)</span>`;
        }

        const isStarred = starredAds.has(String(a.id));
        const starIcon = `<span class="star-icon ${isStarred ? 'starred' : ''}" onclick="toggleStar('${a.id}')">★</span>`;
        const isChecked = compareSet.has(String(a.id));

        const identifiedName = ma.productName ? `<strong>${escapeHtml(ma.productName)}</strong><br><small style="color:var(--text-muted);">${escapeHtml(a.title)}</small>` : escapeHtml(a.title || 'Sans titre');
        const marketRange = ma.marketMin ? `<strong>${ma.marketMin} € - ${ma.marketMax} €</strong><br><small style="color:var(--text-muted);">Moyenne : ${ma.marketAvg} €</small>` : '<small style="color:var(--text-muted);">-</small>';
        const resellText = ma.netMarginEur != null ? `<strong style="color:var(--green-deal);">${ma.netMarginEur > 0 ? '+' : ''}${ma.netMarginEur} €</strong><br><small>(${ma.roiPct}% ROI)</small>` : '-';
        const explanationText = ma.summary ? `<div class="desc-tooltip" title="${escapeHtml(ma.summary)}">${escapeHtml(ma.summary)}</div>` : '<small style="color:var(--text-muted);">-</small>';

        // Rendu de la note sémantique sur 100
        const scoreHtml = ma.score !== undefined 
          ? `<br><small style="color:var(--text-muted); font-weight:bold;">Note : ${ma.score}/100</small>` 
          : '';

        return `
        <tr>
          <td class="text-center"><input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleCompare('${a.id}')"></td>
          <td class="text-center">${starIcon}</td>
          <td>${identifiedName}</td>
          <td><strong>${a.price != null ? a.price + ' €' : '-'}</strong></td>
          <td>${marketRange}</td>
          <td>${resellText}</td>
          <td>${badgeHtml}${scoreHtml}</td>
          <td>${explanationText}</td>
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
        let badgeHtml = `<span class="tag-deal-normal">Prix marché</span>`;

        if (ma.classification === 'Très bonne affaire') {
          badgeHtml = `<span class="tag-deal-super">🟢🟢 -${Math.abs(ma.diffPct)}%</span>`;
        } else if (ma.classification === 'Bonne affaire') {
          badgeHtml = `<span class="tag-deal-good">🟢 -${Math.abs(ma.diffPct)}%</span>`;
        } else if (ma.classification === 'Trop cher') {
          badgeHtml = `<span class="tag-deal-superhigh">🔴 +${ma.diffPct}%</span>`;
        }

        const isStarred = starredAds.has(String(a.id));
        const thumbUrl = Array.isArray(a.images) && a.images.length > 0 ? a.images[0] : 'https://via.placeholder.com/250x160?text=Pas+de+photo';

        return `
        <div class="ad-card">
          <div class="ad-card-thumb-box">
            <img src="${thumbUrl}" alt="Photo" class="ad-card-thumb" onclick="openAdDetail('${a.id}')">
            <div class="ad-card-badge-box">${badgeHtml}</div>
            <div class="ad-card-star"><span class="star-icon ${isStarred ? 'starred' : ''}" onclick="toggleStar('${a.id}')">★</span></div>
          </div>
          <div class="ad-card-body">
            <div class="ad-card-title">${escapeHtml(ma.productName || a.title)}</div>
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
  modalAdTitle.textContent = targetAd.title || 'Détails de l\'annonce';
  modalPrice.textContent = targetAd.price != null ? targetAd.price : '-';
  modalMarketAvg.textContent = ma.marketAvg || '-';
  modalMarketRange.textContent = ma.marketMin ? `${ma.marketMin} € - ${ma.marketMax} €` : 'Non estimé';
  modalResellMargin.textContent = ma.netMarginEur != null ? `${ma.netMarginEur > 0 ? '+' : ''}${ma.netMarginEur} € (ROI ${ma.roiPct}%)` : '-';
  modalCity.textContent = targetAd.city || 'Inconnue';
  modalSeller.textContent = `${targetAd.seller || 'Particulier'}${targetAd.isPro ? ' (Pro)' : ''}`;
  modalDate.textContent = targetAd.date || '-';
  modalSummary.textContent = ma.summary || 'Aucune analyse effectuée.';
  modalDescription.textContent = targetAd.description || 'Aucune description disponible.';

  // Badges Modal
  if (ma.classification === 'Très bonne affaire') {
    modalDealBadge.className = 'tag-deal-super';
    modalDealBadge.textContent = `🟢🟢 Très Bonne Affaire (${ma.diffPct}%)`;
  } else if (ma.classification === 'Bonne affaire') {
    modalDealBadge.className = 'tag-deal-good';
    modalDealBadge.textContent = `🟢 Bonne Affaire (${ma.diffPct}%)`;
  } else {
    modalDealBadge.className = 'tag-deal-normal';
    modalDealBadge.textContent = 'Prix marché';
  }

  // Photos & Carrousel
  const images = Array.isArray(targetAd.images) && targetAd.images.length > 0 ? targetAd.images : ['https://via.placeholder.com/400x250?text=Pas+de+photo'];
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

  const goodDeals = sourceAds.filter((a) => a.marketAnalysis?.classification === 'Très bonne affaire' || a.marketAnalysis?.classification === 'Bonne affaire').length;
  const highDeals = sourceAds.filter((a) => a.marketAnalysis?.classification === 'Trop cher').length;

  statGoodDeals.textContent = `${goodDeals} affaires`;
  statRisks.textContent = `${highDeals} annonces`;
  statTotalAds.textContent = `${sourceAds.length}`;

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

    const res = await fetch(url);
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

  // Filtrer les annonces "main propre" uniquement
  let targetAds = ads;
  if (mapHandDeliveryOnly) {
    targetAds = ads.filter((a) => {
      // shipping est un booléen Leboncoin (true = livraison possible, false/null = remise main propre)
      return !a.shipping;
    });
  }

  for (const a of targetAds) {
    // Interroger l'API Gouv avec cache
    const coords = await geocodeCityGov(a.city, a.zipcode);
    
    if (coords) {
      // Légère variation aléatoire (jitter) pour éviter que les annonces de la même ville se superposent
      const jitterCoords = [
        coords[0] + (Math.random() - 0.5) * 0.012,
        coords[1] + (Math.random() - 0.5) * 0.012
      ];

      const marker = L.marker(jitterCoords).addTo(mapInstance);
      marker.bindPopup(`
        <div style="font-family:sans-serif; font-size:0.8rem; line-height:1.3;">
          <strong>${escapeHtml(a.title)}</strong><br>
          <span style="color:var(--primary-color); font-weight:bold;">${a.price} €</span><br>
          📍 ${escapeHtml(a.city || 'Ville')}<br>
          🤝 Remise en main propre<br>
          <a href="#" onclick="openUrl('${escapePath(a.url)}'); return false;" style="color:#38bdf8; text-decoration:underline;">Ouvrir l'annonce</a>
        </div>
      `);
    }
  }
}

function renderCharts(ads) {
  if (typeof Chart === 'undefined' || ads.length === 0) return;

  const superDeals = ads.filter((a) => a.marketAnalysis?.classification === 'Très bonne affaire').length;
  const goodDeals = ads.filter((a) => a.marketAnalysis?.classification === 'Bonne affaire').length;
  const normalDeals = ads.filter((a) => !a.marketAnalysis || a.marketAnalysis?.classification === 'Prix correct').length;
  const highDeals = ads.filter((a) => a.marketAnalysis?.classification === 'Légèrement cher' || a.marketAnalysis?.classification === 'Trop cher').length;

  const proCount = ads.filter((a) => a.isPro).length;
  const partCount = ads.length - proCount;

  const dealsCtx = document.getElementById('dealsChart').getContext('2d');
  if (dealsChartInstance) dealsChartInstance.destroy();

  dealsChartInstance = new Chart(dealsCtx, {
    type: 'doughnut',
    data: {
      labels: ['🟢🟢 Très Bonne Affaire', '🟢 Bonne Affaire', '🟠 Prix Correct', '🔴 Trop Cher'],
      datasets: [
        {
          data: [superDeals, goodDeals, normalDeals, highDeals],
          backgroundColor: ['#22c55e', '#10b981', '#f59e0b', '#ef4444'],
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { title: { display: true, text: 'Répartition des Opportunités' } },
    },
  });

  const sellerCtx = document.getElementById('sellerChart').getContext('2d');
  if (sellerChartInstance) sellerChartInstance.destroy();

  sellerChartInstance = new Chart(sellerCtx, {
    type: 'doughnut',
    data: {
      labels: ['Particuliers', 'Professionnels'],
      datasets: [
        {
          data: [partCount, proCount],
          backgroundColor: ['#38bdf8', '#8b5cf6'],
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { title: { display: true, text: 'Vendeurs Particuliers vs Pros' } },
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
  if (pendingDeleteJobId) {
    await window.api.deleteJob(pendingDeleteJobId);
    confirmModal.classList.add('hidden');
    pendingDeleteJobId = null;
    await loadHistoryPage();
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

// ============================================================
// PAGE PLANIFICATEUR — chargement, ajout, suppression, déclenchement
// ============================================================

async function loadSchedulerPage() {
  try {
    const tasks = await window.api.listSchedules();
    renderSchedulerTable(tasks);
  } catch (err) {
    schedTableBody.innerHTML = `<tr><td colspan="4" class="text-center">Erreur planificateur : ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderSchedulerTable(tasks) {
  if (!tasks || tasks.length === 0) {
    schedTableBody.innerHTML = '<tr><td colspan="4" class="text-center">Aucune tâche planifiée activée</td></tr>';
    return;
  }

  schedTableBody.innerHTML = tasks
    .map((t) => {
      const nextRunTxt = t.nextRun ? new Date(t.nextRun).toLocaleString('fr-FR') : '-';
      const lastRunTxt = t.lastRun ? new Date(t.lastRun).toLocaleString('fr-FR') : 'Jamais';
      return `
      <tr>
        <td>${escapeHtml(t.searchUrl || '-')}</td>
        <td>${t.intervalMinutes || '?'} min</td>
        <td>Prochaine : ${escapeHtml(nextRunTxt)}<br><small class="text-muted">Dernière : ${escapeHtml(lastRunTxt)}</small></td>
        <td><button class="btn btn-danger btn-small" onclick="removeSchedule('${escapeHtml(t.id)}')">🗑️ Supprimer</button></td>
      </tr>
    `;
    })
    .join('');
}

addSchedBtn.addEventListener('click', async () => {
  const url = schedUrl.value.trim();
  if (!url) {
    alert('Veuillez entrer une URL à surveiller.');
    return;
  }
  const interval = parseInt(schedInterval.value, 10) || 30;
  const task = {
    id: `sched-${Date.now()}`,
    searchUrl: url,
    pages: parseInt(document.getElementById('pages').value, 10) || 1,
    intervalMinutes: interval,
    noDesc: document.getElementById('noDesc').checked,
    csv: document.getElementById('csv').checked,
    autoAiMarket: autoAiMarket.checked,
    limit: document.getElementById('limit').value ? parseInt(document.getElementById('limit').value, 10) : undefined,
    aiConfig: {
      provider: aiProvider.value,
      model: aiModelName.value.trim() || 'llama3',
      apiKey: aiApiKey.value,
    },
    proxyUrl: proxyUrl.value.trim() || undefined,
  };

  try {
    addSchedBtn.disabled = true;
    const tasks = await window.api.addSchedule(task);
    renderSchedulerTable(tasks);
    schedUrl.value = '';
  } catch (err) {
    alert(`Erreur planification : ${err.message}`);
  } finally {
    addSchedBtn.disabled = false;
  }
});

window.removeSchedule = async (id) => {
  try {
    const tasks = await window.api.removeSchedule(id);
    renderSchedulerTable(tasks);
  } catch (err) {
    alert(`Erreur suppression tâche : ${err.message}`);
  }
};

// Déclenchement d'une tâche planifiée par le main process → on lance le scraping
window.api.onSchedulerTrigger((config) => {
  statusText.textContent = '⏰ Tâche planifiée déclenchée — lancement automatique...';
  window.api.startScraping(config);
});