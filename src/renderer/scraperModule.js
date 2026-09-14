// 📶 Mode hors-ligne : détection de connectivité + badge dans l'en-tête.
// L'utilisateur peut consulter les jobs déjà scrapés (lecture disque) mais ne
// peut pas lancer un nouveau scraping ni une analyse IA en ligne.
const offlineBadge = document.getElementById('offlineBadge');

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

// 🩺 Vérification du binaire Chromium (Playwright) au démarrage. Sans ce
// binaire, le scraping échoue immédiatement avec « Executable doesn't exist ».
// On affiche un bandeau rouge tant qu'il manque, avec la commande à lancer.
const chromiumWarningEl = document.getElementById('chromiumWarning');
const chromiumWarningRetryBtn = document.getElementById('chromiumWarningRetry');

async function refreshChromiumCheck() {
  if (!window.api || !window.api.checkChromium) return;
  try {
    const res = await window.api.checkChromium();
    if (res && res.ok) {
      // Binaire présent : on masque le bandeau (s'il était affiché).
      if (chromiumWarningEl) chromiumWarningEl.classList.add('hidden');
    } else {
      if (chromiumWarningEl) chromiumWarningEl.classList.remove('hidden');
      if (chromiumWarningRetryBtn) {
        chromiumWarningRetryBtn.textContent = '🔄 Revérifier';
        chromiumWarningRetryBtn.disabled = false;
      }
    }
  } catch (err) {
    // Erreur IPC : on n'affiche pas le bandeau (ne pas alarmer pour un souci
    // de communication), mais on log en console pour le débogage.
    console.warn('[Chromium] Vérification impossible :', err && err.message);
  }
}

if (chromiumWarningRetryBtn) {
  chromiumWarningRetryBtn.addEventListener('click', () => {
    chromiumWarningRetryBtn.textContent = '⏳ Vérification…';
    chromiumWarningRetryBtn.disabled = true;
    refreshChromiumCheck();
  });
}
refreshChromiumCheck(); // vérification initiale

// Proxy & AI
proxyUrl.value = localStorage.getItem('proxy-url') || '';
proxyUrl.addEventListener('change', (e) => localStorage.setItem('proxy-url', e.target.value));

// ─── Mode d'export (Défaut / Personnalisé) + sélection des champs ──────
// Le mode Défaut conserve l'export exhaustif (compatibilité ascendante).
// Le mode Personnalisé permet de ne sélectionner que les champs dont
// l'utilisateur a besoin (1 champ, plusieurs, ou quasi-tous).
// Les champs possibles sont listés dans src/main/services/exporting/exportFields.js
// (récupérés ici via une constante statique alignée sur DEFAULT_FIELDS).
const EXPORT_FIELDS = [
  { key: 'id', label: 'ID' },
  { key: 'title', label: 'Titre' },
  { key: 'url', label: 'URL' },
  { key: 'produitIdentifie', label: 'Produit identifié (IA)' },
  { key: 'resumeIA', label: 'Résumé IA' },
  { key: 'prix', label: 'Prix' },
  { key: 'ville', label: 'Ville' },
  { key: 'codePostal', label: 'Code postal' },
  { key: 'vendeurNom', label: 'Vendeur (nom)' },
  { key: 'vendeurType', label: 'Vendeur (type)' },
  { key: 'vendeurId', label: 'Vendeur (ID)' },
  { key: 'vendeurNote', label: 'Vendeur (note)' },
  { key: 'vendeurNbAvis', label: 'Vendeur (nb avis)' },
  { key: 'vendeurUrlProfil', label: 'Vendeur (URL profil)' },
  { key: 'vendeurAnciennete', label: 'Vendeur (ancienneté)' },
  { key: 'livraison', label: 'Livraison' },
  { key: 'mainPropre', label: 'Main propre' },
  { key: 'likes', label: 'Likes' },
  { key: 'datePublication', label: 'Date publication' },
  { key: 'dateModification', label: 'Date modification' },
  { key: 'dateScraping', label: 'Date scraping' },
  { key: 'etat', label: 'État déclaré' },
  { key: 'photosCount', label: 'Nombre de photos' },
  { key: 'photosUrls', label: 'URLs des photos' },
  { key: 'description', label: 'Description' },
  { key: 'verdict', label: 'Verdict IA Marché' },
  { key: 'valeurMarche', label: 'Valeur marché (€)' },
  { key: 'fourchette', label: 'Fourchette marché (€)' },
  { key: 'benefice', label: 'Bénéfice/Perte (€)' },
  { key: 'justification', label: 'Justification IA Marché' },
];
const exportModeRadios = document.querySelectorAll('input[name="exportMode"]');
const exportFieldsPanel = document.getElementById('exportFieldsPanel');
const exportFieldsList = document.getElementById('exportFieldsList');
const exportFieldsAll = document.getElementById('exportFieldsAll');
const exportFieldsNone = document.getElementById('exportFieldsNone');
const exportFieldsCount = document.getElementById('exportFieldsCount');

// Persistance localStorage du mode + des champs sélectionnés (clé : lbc-export-config).
const EXPORT_CONFIG_KEY = 'lbc-export-config';
function loadExportConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(EXPORT_CONFIG_KEY) || 'null');
    if (saved && (saved.mode === 'custom' || saved.mode === 'default')) return saved;
  } catch { /* JSON corrompu : on retombe sur default */ }
  return { mode: 'default', fields: [] };
}
function saveExportConfig() {
  const cfg = {
    mode: getSelectedExportMode(),
    fields: getSelectedExportFields(),
  };
  try { localStorage.setItem(EXPORT_CONFIG_KEY, JSON.stringify(cfg)); } catch { /* quota */ }
}
function getSelectedExportMode() {
  const el = document.querySelector('input[name="exportMode"]:checked');
  return el ? el.value : 'default';
}
function getSelectedExportFields() {
  if (!exportFieldsList) return [];
  return [...exportFieldsList.querySelectorAll('input[type="checkbox"]:checked')]
    .map((cb) => cb.value);
}
function updateExportFieldsCount() {
  if (!exportFieldsCount) return;
  const n = getSelectedExportFields().length;
  exportFieldsCount.textContent = `${n} champ(s) sélectionné(s)`;
}
function renderExportFieldsList() {
  if (!exportFieldsList) return;
  const savedCfg = loadExportConfig();
  const checkedSet = new Set(Array.isArray(savedCfg.fields) ? savedCfg.fields : []);
  exportFieldsList.innerHTML = EXPORT_FIELDS.map((f) => {
    const isChecked = checkedSet.has(f.key) ? 'checked' : '';
    return `<label class="checkbox-label" style="font-size:0.8rem;"><input type="checkbox" value="${f.key}" ${isChecked}> ${escapeHtml(f.label)}</label>`;
  }).join('');
  // Ré-attache les listeners de changement (innerHTML les a effacés)
  exportFieldsList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => { updateExportFieldsCount(); saveExportConfig(); });
  });
  updateExportFieldsCount();
}
function setExportMode(mode) {
  for (const r of exportModeRadios) r.checked = (r.value === mode);
  if (exportFieldsPanel) exportFieldsPanel.classList.toggle('hidden', mode !== 'custom');
  saveExportConfig();
}
if (exportModeRadios && exportModeRadios.length > 0) {
  for (const r of exportModeRadios) {
    r.addEventListener('change', () => setExportMode(r.value));
  }
}
if (exportFieldsAll) {
  exportFieldsAll.addEventListener('click', () => {
    if (!exportFieldsList) return;
    for (const cb of exportFieldsList.querySelectorAll('input[type="checkbox"]')) cb.checked = true;
    updateExportFieldsCount(); saveExportConfig();
  });
}
if (exportFieldsNone) {
  exportFieldsNone.addEventListener('click', () => {
    if (!exportFieldsList) return;
    for (const cb of exportFieldsList.querySelectorAll('input[type="checkbox"]')) cb.checked = false;
    updateExportFieldsCount(); saveExportConfig();
  });
}
renderExportFieldsList();
// Restaure le mode sauvegardé
setExportMode(loadExportConfig().mode);

const aiVisionModelEl = document.getElementById('aiVisionModel');
const analyzeImages = { checked: true }; // rétro-compat : la vision est désormais intégrée à l'IA Analyse

// Persistance de l'URL Ollama
if (ollamaUrlEl) {
  ollamaUrlEl.value = localStorage.getItem('ollama-url') || 'http://127.0.0.1:11434';
  ollamaUrlEl.addEventListener('change', (e) => localStorage.setItem('ollama-url', e.target.value));
}
const getOllamaUrl = () => (ollamaUrlEl && ollamaUrlEl.value ? ollamaUrlEl.value : 'http://127.0.0.1:11434');

// Persistance du modèle vision.
if (aiVisionModelEl) {
  aiVisionModelEl.value = localStorage.getItem('ai-vision-model') || 'llava';
  aiVisionModelEl.addEventListener('change', (e) => localStorage.setItem('ai-vision-model', e.target.value));
}

// OpenAI a été retiré : l'IA est 100% locale via Ollama, aucun champ clé API
// dans le scraper. On garde un accesseur sûr (null-tolerant) pour ne pas casser
// les appels existants (config scraping / analyse) — la clé vaut toujours ''.
const getAiApiKey = () => (aiApiKeyEl && aiApiKeyEl.value ? aiApiKeyEl.value : '');

// Moteur de recherche pour l'IA Marché (Option C : sans-clé par défaut).
// Peuple dynamiquement la liste via le registre côté main process.
const searchApiKeyEl = document.getElementById('searchApiKey');
const SEARCH_KEY_SECRET = 'search-api-key';
const getSearchApiKey = () => (searchApiKeyEl && searchApiKeyEl.value ? searchApiKeyEl.value : '');

// Persiste/charge la clé API du moteur de recherche via le secretStore chiffré
// (safeStorage OS) plutôt qu'en clair dans localStorage. Sans cela, la clé Tavily
// disparaissait à chaque redémarrage (non persistée), rendant le moteur à clé
// inutilisable entre sessions.
async function loadSearchApiKey() {
  try {
    const stored = await window.api.getSecret(SEARCH_KEY_SECRET);
    if (stored && searchApiKeyEl) searchApiKeyEl.value = stored;
  } catch (err) {
    console.warn('[search] Chargement clé API moteur échoué :', err.message);
  }
}
async function saveSearchApiKey(value) {
  try {
    if (value) await window.api.setSecret(SEARCH_KEY_SECRET, value);
    else await window.api.removeSecret(SEARCH_KEY_SECRET);
  } catch (err) {
    console.warn('[search] Sauvegarde clé API moteur échouée :', err.message);
  }
}

if (searchProviderSelect) {
  searchProviderSelect.value = localStorage.getItem('search-provider') || 'duckduckgo';
  searchProviderSelect.addEventListener('change', (e) => {
    localStorage.setItem('search-provider', e.target.value);
    // N'affiche le champ clé que pour les moteurs qui en nécessitent une.
    if (searchApiKeyEl && searchApiKeyEl.parentElement) {
      const needsKey = e.target.value !== 'duckduckgo';
      searchApiKeyEl.parentElement.classList.toggle('hidden', !needsKey);
      if (needsKey) loadSearchApiKey();
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
      // Charge la clé persistée si le moteur courant en nécessite une.
      if (needsKey) loadSearchApiKey();
    }
  }).catch(() => { /* liste non disponible — fallback duckduckgo */ });
}

// Persiste la clé API quand l'utilisateur la saisit (chiffrée via secretStore).
if (searchApiKeyEl) {
  searchApiKeyEl.addEventListener('change', () => saveSearchApiKey(searchApiKeyEl.value));
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
// + options IA + proxy + moteur de recherche IA Marché) afin qu'un preset soit
// réellement une restauration « 1-clic » de la recherche, et pas seulement
// URL + pages. Le moteur de recherche (DuckDuckGo/Tavily) est inclus pour
// cohérence : un preset sauvegardé avec Tavily se recharge avec Tavily.
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
    ollamaUrl: getOllamaUrl(),
    aiVisionModel: localStorage.getItem('ai-vision-model') || 'llava',
    searchProvider: (searchProviderSelect && searchProviderSelect.value) || 'duckduckgo',
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
  if (cfg.ollamaUrl != null) {
    if (ollamaUrlEl) ollamaUrlEl.value = cfg.ollamaUrl;
    localStorage.setItem('ollama-url', cfg.ollamaUrl);
  }
  if (cfg.aiVisionModel != null) {
    if (aiVisionModelEl) aiVisionModelEl.value = cfg.aiVisionModel;
    localStorage.setItem('ai-vision-model', cfg.aiVisionModel);
  }
  // Restaure le moteur de recherche IA Marché (DuckDuckGo/Tavily).
  // On dispatch un événement 'change' pour que le handler existant masque/affiche
  // le champ clé API et charge la clé persistée (secretStore) si nécessaire.
  if (cfg.searchProvider && searchProviderSelect) {
    searchProviderSelect.value = cfg.searchProvider;
    localStorage.setItem('search-provider', cfg.searchProvider);
    searchProviderSelect.dispatchEvent(new Event('change'));
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
const closeCompareModalBtn = document.getElementById('closeCompareModalBtn');
const compareGrid = document.getElementById('compareGrid');
const compareCount = document.getElementById('compareCount');

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
        <img src="${escapeHtml((a.photosUrls && a.photosUrls[0]) || (a.images && a.images[0]) || noPhotoUrl())}" style="width:100%; height:140px; object-fit:cover; border-radius:6px;">
        <strong>${escapeHtml(identifiedName(a))}</strong>
        <div style="font-size:1.2rem; font-weight:bold; color:var(--primary-color);">${a.prix != null ? a.prix + ' €' : (a.price != null ? a.price + ' €' : '-')}</div>
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
toggleWidgetBtn.addEventListener('click', () => {
  window.api.toggleWidget();
  widgetActive = !widgetActive;
  toggleWidgetBtn.classList.toggle('btn-active', widgetActive);
  toggleWidgetBtn.title = widgetActive ? 'Widget flottant ouvert — cliquez pour fermer' : 'Ouvrir le widget flottant';
});

// Modal Paramètres
const openSettingsModalBtn = document.getElementById('openSettingsModalBtn');
const closeSettingsModalBtn = document.getElementById('closeSettingsModalBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const resetSettingsBtn = document.getElementById('resetSettingsBtn');
const cfgTheme = document.getElementById('cfgTheme');
const cfgScrapeSpeed = document.getElementById('cfgScrapeSpeed');
const cfgPageDelay = document.getElementById('cfgPageDelay');
const cfgHeadless = document.getElementById('cfgHeadless');
const cfgIncludeSellerData = document.getElementById('cfgIncludeSellerData');
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
  if (cfgIncludeSellerData) cfgIncludeSellerData.checked = cfg.includeSellerData !== false;
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
    includeSellerData: cfgIncludeSellerData ? cfgIncludeSellerData.checked : true,
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
    includeSellerData: true,
    aiConcurrency: 5,
    autoCleanHarDays: 7,
    autoCleanJobsDays: 0,
    logRetentionDays: 7,
  });
  applySettingsToUI({ scrapeSpeed: 'fast', pageDelayMs: 1000, headless: true, includeSellerData: true, aiConcurrency: 5, autoCleanHarDays: 7, autoCleanJobsDays: 0, logRetentionDays: 7 });
  alert('Paramètres réinitialisés.');
});

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
      ollamaUrl: getOllamaUrl(),
      apiKey: getAiApiKey(),
    },
    // Mode d'export (Défaut / Personnalisé) + champs sélectionnés. Le main
    // process applique ce mode à TOUS les exports : JSON, TXT, Texte raccourci,
    // XLSX, CSV. En mode Défaut, exportFields est ignoré (toutes les colonnes).
    exportMode: getSelectedExportMode(),
    exportFields: getSelectedExportMode() === 'custom' ? getSelectedExportFields() : null,
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
  // L'IA Marché a besoin d'Internet (recherche DuckDuckGo/Tavily). En mode
  // hors-ligne, toutes les estimations tombent en fallback inutile — on bloque
  // tôt avec un message clair au lieu de lancer un batch qui ne produira rien.
  if (isOffline) {
    const provider = (searchProviderSelect && searchProviderSelect.value) || 'duckduckgo';
    alert(`📶 Mode hors-ligne actif. L'analyse de marché nécessite une recherche Internet (${provider}) qui est indisponible. Vérifiez votre connexion.`);
    return;
  }
  triggerMarketBtn.disabled = true;
  // Active le bouton « Arrêter » pendant l'IA Marché : le job:stop handler
  // annule maintenant aussi l'analyse de marché (token activeCancel partagé).
  stopBtn.disabled = false;
  progressBar.style.width = '0%';
  statusText.textContent = 'Analyse de marché IA (recherche Internet + estimation)...';
  // Affiche la barre de progression dédiée dans l'explorateur
  const marketProgressContainer = document.getElementById('marketProgressContainer');
  const marketProgressBar = document.getElementById('marketProgressBar');
  const marketProgressText = document.getElementById('marketProgressText');
  if (marketProgressContainer) marketProgressContainer.classList.remove('hidden');
  if (marketProgressBar) marketProgressBar.style.width = '0%';
  if (marketProgressText) marketProgressText.textContent = '0%';

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
        ollamaUrl: getOllamaUrl(),
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
    if (marketProgressContainer) marketProgressContainer.classList.add('hidden');
  } catch (err) {
    statusText.textContent = 'Statut : Échec de l\'analyse de marché.';
    alert(`Erreur d'analyse : ${err.message}`);
    if (marketProgressContainer) marketProgressContainer.classList.add('hidden');
  } finally {
    triggerMarketBtn.disabled = false;
    stopBtn.disabled = true;
    if (marketProgressContainer) marketProgressContainer.classList.add('hidden');
  }
});

window.api.onProgress(({ percent, status, eta }) => {
  if (percent !== undefined) progressBar.style.width = `${percent}%`;
  if (status) statusText.textContent = `Statut : ${status}`;
  if (eta) etaText.textContent = `ETA : ${eta}`;
  // Met à jour aussi la barre de progression IA Marché dans l'explorateur
  const mpBar = document.getElementById('marketProgressBar');
  const mpText = document.getElementById('marketProgressText');
  if (mpBar && percent !== undefined) mpBar.style.width = `${percent}%`;
  if (mpText && percent !== undefined) mpText.textContent = `${Math.round(percent)}%`;
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

    // Un scraping vient de se terminer : on rafraîchit l'onglet de données
    // actuellement affiché pour qu'aucune donnée ancienne ne persiste après
    // un nouveau scraping (cohérence Historique / Explorateur / Statistiques).
    // On ne rafraîchit QUE l'onglet actif pour éviter un rechargement inutile
    // des autres (ils se rafraîchiront au prochain clic sur leur onglet).
    if (state === 'completed') {
      refreshActiveDataTab();
    }
  }
  // Transmet au widget flottant (si ouvert)
  if (typeof window.api.sendWidgetStatus === 'function') {
    window.api.sendWidgetStatus({ state, message });
  }
});
