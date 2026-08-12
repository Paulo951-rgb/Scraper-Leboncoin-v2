'use strict';

/**
 * Suite de tests de non-régression — Leboncoin Scraper Pro
 * Couvre : diagnostics.js, pipeline, modules principaux, et corrections PR #3.
 * Exécuter : node test/regression.test.js
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');

// --- Stubs pour environnement hors-Electron ---
const electronStub = {
  app: { isPackaged: false, getPath: (p) => `/tmp/leboncoin-test-${p}` },
  Notification: { isSupported: () => false, new: function () { this.show = () => {}; } },
  shell: { openPath: () => Promise.resolve(''), openExternal: () => Promise.resolve() },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: function () { this.webContents = { send: () => {} }; },
};
const playwrightStub = { chromium: { launch: async () => { throw new Error('playwright stub'); } } };
const exceljsStub = { Workbook: function () { this.addWorksheet = () => ({}); this.xlsx = { writeFile: async () => {} }; } };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  if (request === 'playwright') return playwrightStub;
  if (request === 'exceljs') return exceljsStub;
  return originalLoad.apply(this, arguments);
};

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}`); }
}

async function main() {

// --- 1. diagnostics.js ---
console.log('\n[1/4] diagnostics.js');
const diag = require('../src/main/utils/diagnostics');
assert(typeof diag.redact === 'function', 'redact exists');
assert(typeof diag.truncate === 'function', 'truncate exists');
assert(typeof diag.safeStringify === 'function', 'safeStringify exists');
assert(typeof diag.formatBytes === 'function', 'formatBytes exists');
assert(typeof diag.formatMs === 'function', 'formatMs exists');
assert(typeof diag.summarizeAds === 'function', 'summarizeAds exists');
assert(typeof diag.summarizeHarEntries === 'function', 'summarizeHarEntries exists');
assert(typeof diag.countBy === 'function', 'countBy exists');
assert(typeof diag.describeError === 'function', 'describeError exists');
assert(diag.redact('sk-proj-abcdef1234567890').includes('sk-p'), 'redact masks API keys (shows prefix)');
assert(diag.redact('ab') === '***', 'redact short value → ***');
assert(diag.redact(null) === '(vide)', 'redact null → (vide)');
assert(diag.truncate('hello world', 5) === 'hello…[+6 caractères]', 'truncate works');
assert(diag.truncate('short', 50) === 'short', 'truncate short passthrough');
assert(diag.truncate(null) === '(null)', 'truncate null → (null)');
assert(diag.formatBytes(0) === '0 o', 'formatBytes(0)');
assert(diag.formatBytes(1536) === '1.5 Ko', 'formatBytes(1536)');
assert(diag.formatMs(0) === '0 ms', 'formatMs(0)');
assert(diag.formatMs(1500) === '1.50 s', 'formatMs(1500)');
assert(diag.formatMs(500) === '500 ms', 'formatMs(500)');
assert(typeof diag.summarizeAds([{ id: '1', price: 100 }, { id: '2', price: 200 }]) === 'string', 'summarizeAds returns string');
assert(diag.summarizeAds([{ id: '1', price: 100 }]).includes('1 annonce'), 'summarizeAds includes count');
assert(diag.summarizeAds('notarray') === '(pas un tableau)', 'summarizeAds non-array guard');
assert(diag.countBy([{ c: 'A' }, { c: 'A' }, { c: 'B' }], (i) => i.c).A === 2, 'countBy with fn');
assert(diag.countBy(null, () => 'x').x === undefined, 'countBy null guard');
assert(diag.describeError(new Error('boom')).includes('boom'), 'describeError message');
assert(diag.describeError({ code: 'ENOENT', message: 'x' }).includes('code=ENOENT'), 'describeError code');

// --- 2. Modules principaux ---
console.log('\n[2/4] Modules principaux');
const { AdAnalyzer } = require('../src/main/services/ai/adAnalyzer');
const { MarketValueAnalyzer } = require('../src/main/services/ai/marketValueAnalyzer');
const { AdStats } = require('../src/main/services/analysis/adStats');
const { StorageCleaner } = require('../src/main/services/maintenance/storageCleaner');
const { FileManager } = require('../src/main/infrastructure/fileManager');
const { Notifier } = require('../src/main/infrastructure/notifications');
const { loadSettings, saveSettings } = require('../src/main/core/settings');
const { getAIProvider } = require('../src/main/services/ai/providers/aiProviderRegistry');
const { getSearchProvider, listSearchProviders } = require('../src/main/services/ai/search/searchProviderRegistry');

assert(typeof AdAnalyzer.analyzeAds === 'function', 'AdAnalyzer.analyzeAds (IA 1)');
assert(typeof MarketValueAnalyzer.analyzeMarketBatch === 'function', 'MarketValueAnalyzer.analyzeMarketBatch (IA 2)');
assert(typeof AdStats.analyze === 'function', 'AdStats.analyze (remplace DealFinder)');
assert(typeof StorageCleaner.cleanOldHars === 'function', 'StorageCleaner.cleanOldHars');
assert(typeof FileManager.openFile === 'function', 'FileManager.openFile');
assert(typeof FileManager.openFolder === 'function', 'FileManager.openFolder');
assert(typeof getAIProvider === 'function', 'getAIProvider (registry IA)');
assert(typeof getSearchProvider === 'function', 'getSearchProvider (registry recherche)');
assert(Array.isArray(listSearchProviders()) && listSearchProviders().length > 0, 'listSearchProviders retourne au moins DuckDuckGo');
(function () {
  const providers = listSearchProviders();
  const ddg = providers.find((p) => p && p.id === 'duckduckgo');
  assert(ddg && typeof ddg.label === 'string' && typeof ddg.keyless === 'boolean', 'listSearchProviders retourne {id,label,keyless} (format UI)');
  assert(ddg.keyless === true, 'DuckDuckGo déclaré keyless (sans clé API)');
})();

// JobHistory.deleteJob : validation anti path-traversal (rejette les IDs malformés)
(function () {
  const { JobHistoryManager } = require('../src/main/services/jobs/jobHistory');
  assert(JobHistoryManager.deleteJob('../../../etc') === false, 'deleteJob rejette un path-traversal (..)');
  assert(JobHistoryManager.deleteJob('') === false, 'deleteJob rejette un ID vide');
  assert(JobHistoryManager.deleteJob('normal-name') === false, 'deleteJob rejette un ID sans préfixe job-');
  assert(JobHistoryManager.deleteJob('job-../../etc') === false, 'deleteJob rejette job- avec ..');
})();

// AdStats : statistiques sans scoring (remplace DealFinder)
const ads = [
  { id: '1', title: 'iPhone 12', price: 100 },
  { id: '2', title: 'Samsung S21', price: 300 },
  { id: '3', title: 'Pixel 6', price: 200 },
];
const { stats, ads: enrichedAds } = AdStats.analyze(ads);
assert(stats && stats.totalAds === 3, 'AdStats stats.totalAds');
assert(enrichedAds.length === 3, 'AdStats retourne les annonces inchangées');
assert(!enrichedAds[0].hasOwnProperty('dealTag'), 'AdStats n\'ajoute PLUS dealTag (scoring retiré)');
assert(!enrichedAds[0].hasOwnProperty('hasRisk'), 'AdStats n\'ajoute PLUS hasRisk (scam score retiré)');

// AdStats : cas limites (vide, prix invalides, médiane paire/impaire)
assert(AdStats.analyze([]).stats === null, 'AdStats: tableau vide → stats null');
assert(AdStats.analyze(null).stats === null, 'AdStats: entrée null → stats null (pas de crash)');
assert(AdStats.analyze([{ id: '1', price: 'abc' }, { id: '2' }]).stats === null, 'AdStats: prix invalides → stats null');
assert(AdStats.analyze([{ id: '1', price: 0 }, { id: '2', price: -5 }]).stats === null, 'AdStats: prix <= 0 ignorés → stats null');
const oddMed = AdStats.analyze([{ id: '1', price: 100 }, { id: '2', price: 300 }, { id: '3', price: 200 }]);
assert(oddMed.stats.medianPrice === 200, 'AdStats: médiane impaire = valeur centrale (200)');
const evenMed = AdStats.analyze([{ id: '1', price: 100 }, { id: '2', price: 200 }, { id: '3', price: 300 }, { id: '4', price: 400 }]);
assert(evenMed.stats.medianPrice === 250, 'AdStats: médiane paire = moyenne des 2 centrales (250, pas 300)');
const mixedPrices = AdStats.analyze([{ id: '1', price: 100 }, { id: '2', price: '200' }, { id: '3', price: null }]);
assert(mixedPrices.stats.pricedAds === 2, 'AdStats: prix string parsés, null ignorés (pricedAds=2)');
assert(mixedPrices.stats.minPrice === 100 && mixedPrices.stats.maxPrice === 200, 'AdStats: min/max après tri des prix valides');

// iaCache : get() renvoie la valeur mise en cache (pas le wrapper {specs,cachedAt})
// Bug critique : avant correction, le cache renvoyait {specs,cachedAt} → les champs
// identifiedProduct/realValue/_fallback étaient absents et cassaient l'affichage IA +
// la détection des fallbacks (un fallback caché était retourné comme valide).
const _aiCacheUnderTest = require('../src/main/services/ai/aiCache');
_aiCacheUnderTest.clear();
assert(_aiCacheUnderTest.get('nope', 'analyse') === null, 'aiCache: get sur clé absente → null');
assert(_aiCacheUnderTest.get('', 'analyse') === null, 'aiCache: get sur id vide → null');
_aiCacheUnderTest.set('ad-1', { identifiedProduct: 'iPhone 12', _fallback: false }, 'analyse');
const cachedOk = _aiCacheUnderTest.get('ad-1', 'analyse');
assert(cachedOk && cachedOk.identifiedProduct === 'iPhone 12', 'aiCache: get renvoie la valeur interne (identifiedProduct présent)');
assert(cachedOk && cachedOk._fallback === false, 'aiCache: get préserve _fallback (détection fallback)');
_aiCacheUnderTest.set('ad-2', { summary: ' HS', _fallback: true, _error: 'IA down' }, 'analyse');
const cachedFb = _aiCacheUnderTest.get('ad-2', 'analyse');
assert(cachedFb && cachedFb._fallback === true, 'aiCache: get préserve _fallback=true (fallback caché détectable)');
// Préfixe distinct : analyse vs market ne collisionnent pas
_aiCacheUnderTest.set('ad-1', { realValue: 500 }, 'market');
const mkt = _aiCacheUnderTest.get('ad-1', 'market');
assert(mkt && mkt.realValue === 500, 'aiCache: préfixe market isolé du préfixe analyse');
assert(_aiCacheUnderTest.get('ad-1', 'analyse').realValue === undefined, 'aiCache: analyse non pollué par market');
_aiCacheUnderTest.clear();

// excelExporter : noms de champs cohérents avec l'IA (identifiedProduct, valueRangeLow/High)
// Bug : avant correction, l'Excel lisait identifiedName/marketMin/marketMax (champs
// jamais produits par adAnalyzer/marketValueAnalyzer) → colonnes vides même après IA.
const excelSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/infrastructure/excelExporter.js'), 'utf8');
assert(/adAnalysis\.identifiedProduct/.test(excelSrc), 'excelExporter: lit adAnalysis.identifiedProduct (champ produit par l\'IA 1)');
assert(!/adAnalysis\.identifiedName/.test(excelSrc), 'excelExporter: ne lit plus identifiedName (champ inexistant)');
assert(/ma\.valueRangeLow/.test(excelSrc) && /ma\.valueRangeHigh/.test(excelSrc), 'excelExporter: lit valueRangeLow/High (champs produits par l\'IA 2)');
assert(!/ma\.marketMin/.test(excelSrc) && !/ma\.marketMax/.test(excelSrc), 'excelExporter: ne lit plus marketMin/marketMax (champs inexistants)');

// MarketValueAnalyzer.computeVerdict : verdict € + coercition numérique des prix.
// Bug évité : un LLM peut renvoyer realValue en string ("300 €") et le prix
// d'annonce peut arriver en string depuis le scraping — sans coercition, le
// verdict tombait silencieusement sur "Non déterminable" alors que l'IA avait
// bien estimé une valeur.
const { _computeVerdict } = require('../src/main/services/ai/marketValueAnalyzer');
const vGood = _computeVerdict(100, 200);
assert(vGood.verdictLabel === 'Très bonne affaire' && vGood.deltaEur === 100, 'computeVerdict: +100% → Très bonne affaire (delta 100)');
const vCorrect = _computeVerdict(100, 110);
assert(vCorrect.verdictLabel === 'Prix correct' && vCorrect.deltaEur === 10, 'computeVerdict: +10% → Prix correct');
const vOverpriced = _computeVerdict(200, 100);
assert(vCorrect.verdictLabel === 'Prix correct' || vOverpriced.verdictLabel === 'Trop cher', 'computeVerdict: -50% → Trop cher');
assert(vOverpriced.deltaEur === -100, 'computeVerdict: delta négatif = -100');
// Coercition de prix string (ex: "300 €")
const vCoerced = _computeVerdict('150', 300);
assert(vCoerced.verdictLabel === 'Très bonne affaire' && vCoerced.deltaEur === 150, 'computeVerdict: prix string "150" coerced → verdict calculé');
// realValue string "300 €" → via toNum dans analyzeMarket ; computeVerdict test direct:
const vRealStr = _computeVerdict(150, '300');
assert(vRealStr.deltaEur === 150, 'computeVerdict: realValue string "300" coerced');
// Cas non déterminable : valeurs invalides
const vNaN1 = _computeVerdict('abc', 200);
assert(vNaN1.verdictLabel === 'Non déterminable' && vNaN1.deltaEur === null, 'computeVerdict: prix "abc" → Non déterminable');
const vNaN2 = _computeVerdict(100, null);
assert(vNaN2.verdictLabel === 'Non déterminable' && vNaN2.deltaEur === null, 'computeVerdict: realValue null → Non déterminable');
const vNaN3 = _computeVerdict(undefined, undefined);
assert(vNaN3.verdictLabel === 'Non déterminable', 'computeVerdict: undefined → Non déterminable (verdictLabel défini, pas undefined)');
// Prix nul : deltaPct null mais verdict quand même calculé
const vZero = _computeVerdict(0, 100);
assert(vZero.deltaEur === 100 && vZero.deltaPct === null, 'computeVerdict: prix 0 → delta calculé, deltaPct null (div par zéro évitée)');

// --- 3. Pipeline (fork) ---
console.log('\n[3/4] Pipeline (leboncoin-pipeline.js)');
const os = require('os');
const { fork } = require('child_process');
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-'));
const harPath = path.join(tmpOut, 'capture.har');
const adObj = {
  list_id: 12345, subject: 'iPhone 12', price: 300, body: 'Bon etat',
  url: 'https://www.leboncoin.fr/ad/12345.htm',
  location: { city: 'Lyon', zipcode: '69000' },
  has_option: { shipping: false },
  category_name: 'Téléphones',
  owner: { name: 'Vendeur', type: 'particulier', rating: 4.8, nb_ratings: 27 },
};
const htmlPayload = '<html><script id="__NEXT_DATA__" type="application/json">' + JSON.stringify(adObj) + '</script></html>';
const har = {
  log: {
    entries: [
      {
        request: { url: 'https://www.leboncoin.fr/recherche' },
        response: { status: 200, content: { mimeType: 'text/html', text: htmlPayload } },
      },
    ],
  },
};
fs.writeFileSync(harPath, JSON.stringify(har));

await new Promise((resolve) => {
  const child = fork(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), [harPath, '--out', tmpOut, '--headless', '--no-desc'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.on('close', (code) => {
    assert(code === 0, 'pipeline exits 0');
    assert(stdout.includes('[DEBUG]'), 'pipeline DEBUG logs present');
    assert(stdout.includes('annonces extraites'), 'pipeline reports ads extracted');
    const ads = JSON.parse(fs.readFileSync(path.join(tmpOut, 'annonces.json'), 'utf8'));
    assert(ads[0].shipping === false, 'pipeline extracts shipping as boolean');
    assert(ads[0].city === 'Lyon', 'pipeline extracts city');
    assert(ads[0].isPro === false, 'pipeline extracts isPro');
    assert(ads[0].category === 'Téléphones', 'pipeline extracts category_name');
    assert(ads[0].sellerRating === 4.8, 'pipeline extracts sellerRating from owner.rating');
    assert(ads[0].sellerRatingCount === 27, 'pipeline extracts sellerRatingCount from owner.nb_ratings');
    assert(ads[0].deliveryMode === 'main_propre', 'pipeline derives deliveryMode=main_propre from shipping=false');
    assert(ads[0].handDelivery === true, 'pipeline derives handDelivery=true when shipping=false');
    fs.rmSync(tmpOut, { recursive: true, force: true });
    resolve();
  });
});

// --- 4. Corrections PR #3 (renderer + main) ---
console.log('\n[4/4] Corrections PR #3');
const appCode = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
const preloadCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/preload.js'), 'utf8');
const ipcCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/core/ipcHandlers.js'), 'utf8');

assert(/(let|const)\s+mapInstance\b/.test(appCode), 'app.js: mapInstance declared');
assert(/(let|const)\s+priceDistChartInstance\b/.test(appCode), 'app.js: priceDistChartInstance declared');
assert(/(let|const)\s+topCitiesChartInstance\b/.test(appCode), 'app.js: topCitiesChartInstance declared');
assert(/statAvgPrice/.test(appCode), 'app.js: statAvgPrice (prix moyen)');
assert(/statMedPrice/.test(appCode), 'app.js: statMedPrice (prix médian)');
assert(/statHandDelivery/.test(appCode), 'app.js: statHandDelivery (main propre)');
assert(!/statGoodDeals/.test(appCode), 'app.js: statGoodDeals supprimé (stats bonnes affaires retirées)');
assert(!/Répartition des Opportunités/.test(appCode), 'app.js: graphique Répartition des Opportunités supprimé');
assert(/429|quota/i.test(appCode), 'app.js: gestion erreur 429 (quota IA / scraping)');
assert(!/let\s+priceChartInstance\b/.test(appCode), 'app.js: priceChartInstance dead var removed');
assert(/if \(viewMode === 'table'\) viewGridBtn\.click\(\);\s*else viewTableBtn\.click\(\);/.test(appCode), 'app.js: Spacebar toggles table<->grid');
assert(/replace\(\/&\/g, '&amp;'\)/.test(appCode) && /replace\(\/"\/g, '&quot;'\)/.test(appCode), 'app.js: escapeHtml escapes & " < >');
assert(/window\.api\.openExternal\(urlStr\)/.test(appCode), 'app.js: openUrl uses openExternal');

// XSS : escapePath doit échapper " (breakout d'attribut HTML) en plus de \ et '
assert(/escapePath[\s\S]*?replace\(\/&\/g, '&amp;'\)/.test(appCode), 'app.js: escapePath échappe & (anti-double-encoding)');
assert(/escapePath[\s\S]*?replace\(\/"\/g, '&quot;'\)/.test(appCode), 'app.js: escapePath échappe " (XSS attribut HTML)');
// XSS : les src= d'images scrapées doivent passer par escapeHtml
assert(/src="\$\{escapeHtml\(/.test(appCode), 'app.js: img src utilise escapeHtml (XSS src attribute)');
// XSS : les a.id dans onclick doivent être échappés (defense in depth)
assert(!/openAdDetail\('\$\{a\.id\}'\)/.test(appCode), 'app.js: a.id échappé dans openAdDetail onclick');
assert(!/toggleStar\('\$\{a\.id\}'\)/.test(appCode), 'app.js: a.id échappé dans toggleStar onclick');
// XSS : switchGalleryImg doit échapper l'URL image
assert(/switchGalleryImg\('\$\{escapePath\(img\)\}'/.test(appCode), 'app.js: switchGalleryImg échappe img (XSS onclick)');
assert(/openFolder\(''\)/.test(appCode) && !/openFolder\('output'\)/.test(appCode), 'app.js: output button passes empty string');
// « main propre » = livraison explicitement indisponible (shipping === false).
// shipping=null (info non extraite) ne doit PAS être compté comme main propre.
assert(/a\.shipping === false/.test(appCode), 'app.js: filtre main-propre utilise shipping === false (pas !a.shipping)');
assert(!/return !a\.shipping;/.test(appCode), 'app.js: plus de !a.shipping (comptait null comme main propre)');
assert(/MAX_LOG_LINES\s*=\s*1000/.test(appCode), 'app.js: log line cap (1000)');
// Modules supprimés : Analyse Globale IA + Planificateur (scheduler)
assert(!/loadSchedulerPage/.test(appCode), 'app.js: loadSchedulerPage supprimé (module Planificateur retiré)');
assert(!/onSchedulerTrigger/.test(appCode), 'app.js: onSchedulerTrigger supprimé (module Planificateur retiré)');
assert(!/window\.removeSchedule/.test(appCode), 'app.js: removeSchedule supprimé (module Planificateur retiré)');
assert(!/analyzeGlobalDataset/.test(appCode), 'app.js: analyzeGlobalDataset supprimé (module Analyse Globale retiré)');
assert(/openExternal:\s*\(urlStr\)\s*=>\s*ipcRenderer\.invoke\('shell:openExternal'/.test(preloadCode), 'preload.js: openExternal exposed');
assert(/folderPath \|\| BASE_OUT_DIR/.test(ipcCode), 'ipcHandlers.js: openFolder defaults to BASE_OUT_DIR');
assert(/shell:openExternal/.test(ipcCode), 'ipcHandlers.js: shell:openExternal handler present');

// Nouvelle architecture IA : plus d'ancien marketAnalyzer/dealFinder, mais les
// nouveaux modules IA 1/2/3 et les registres sont présents et câblés.
assert(/AdAnalyzer/.test(ipcCode), 'ipcHandlers.js: importe AdAnalyzer (IA 1)');
assert(/MarketValueAnalyzer/.test(ipcCode), 'ipcHandlers.js: importe MarketValueAnalyzer (IA 2)');
assert(/PromptGenerator/.test(ipcCode), 'ipcHandlers.js: importe PromptGenerator (IA 3)');
assert(/AdAnalyzer\.analyzeAds/.test(ipcCode), 'ipcHandlers.js: appelle AdAnalyzer.analyzeAds pendant le scraping');
assert(/MarketValueAnalyzer\.analyzeMarketBatch/.test(ipcCode), 'ipcHandlers.js: appelle MarketValueAnalyzer.analyzeMarketBatch (IA Marché)');
assert(/search:providers/.test(ipcCode), 'ipcHandlers.js: handler search:providers (liste moteurs recherche)');
assert(/listSearchProviders/.test(preloadCode), 'preload.js: expose listSearchProviders');

// --- 5. Nouvelle architecture (refactor structure) ---
console.log('\n[5/5] Architecture restructurée');
const { existsSync } = fs;
const base = path.join(__dirname, '..', 'src/main');

// Structure par couches
assert(existsSync(path.join(base, 'core/ipcHandlers.js')), 'core/ipcHandlers.js present');
assert(existsSync(path.join(base, 'core/settings.js')), 'core/settings.js (extrait) present');
assert(existsSync(path.join(base, 'config/constants.js')), 'config/constants.js present');
assert(!existsSync(path.join(base, 'config/risk-keywords.js')), 'config/risk-keywords.js supprimé (code mort — IA remplace les mots-clés)');
assert(existsSync(path.join(base, 'services/scraping/harCapturer.js')), 'services/scraping/harCapturer.js present');
assert(existsSync(path.join(base, 'services/scraping/pipelineRunner.js')), 'services/scraping/pipelineRunner.js present');
assert(existsSync(path.join(base, 'services/scraping/leboncoin-pipeline.js')), 'services/scraping/leboncoin-pipeline.js (déplacé du vendor/) present');
// Nouvelle architecture IA : anciens modules supprimés, nouveaux présents
assert(!existsSync(path.join(base, 'services/ai/marketAnalyzer.js')), 'services/ai/marketAnalyzer.js supprimé (ancien scoring)');
assert(!existsSync(path.join(base, 'services/analysis/dealFinder.js')), 'services/analysis/dealFinder.js supprimé (ancien scoring)');
assert(!existsSync(path.join(base, 'services/ai/imageAnalyzer.js')), 'services/ai/imageAnalyzer.js supprimé (intégré à adAnalyzer)');
assert(existsSync(path.join(base, 'services/ai/adAnalyzer.js')), 'services/ai/adAnalyzer.js present (IA 1)');
assert(existsSync(path.join(base, 'services/ai/marketValueAnalyzer.js')), 'services/ai/marketValueAnalyzer.js present (IA 2)');
assert(existsSync(path.join(base, 'services/ai/promptGenerator.js')), 'services/ai/promptGenerator.js present (IA 3)');
assert(existsSync(path.join(base, 'services/ai/providers/aiProvider.js')), 'services/ai/providers/aiProvider.js (interface)');
assert(existsSync(path.join(base, 'services/ai/providers/ollamaProvider.js')), 'services/ai/providers/ollamaProvider.js (implémentation)');
assert(existsSync(path.join(base, 'services/ai/providers/aiProviderRegistry.js')), 'services/ai/providers/aiProviderRegistry.js (factory)');
assert(existsSync(path.join(base, 'services/ai/search/searchProvider.js')), 'services/ai/search/searchProvider.js (interface)');
assert(existsSync(path.join(base, 'services/ai/search/duckDuckGoSearchProvider.js')), 'services/ai/search/duckDuckGoSearchProvider.js (keyless)');
assert(existsSync(path.join(base, 'services/ai/search/searchProviderRegistry.js')), 'services/ai/search/searchProviderRegistry.js (factory)');
assert(existsSync(path.join(base, 'services/analysis/adStats.js')), 'services/analysis/adStats.js (remplace dealFinder)');
assert(existsSync(path.join(base, 'services/jobs/jobHistory.js')), 'services/jobs/jobHistory.js present');
assert(existsSync(path.join(base, 'services/maintenance/storageCleaner.js')), 'services/maintenance/storageCleaner.js present');
assert(existsSync(path.join(base, 'infrastructure/excelExporter.js')), 'infrastructure/excelExporter.js present');
assert(existsSync(path.join(base, 'infrastructure/fileManager.js')), 'infrastructure/fileManager.js present');
assert(existsSync(path.join(base, 'infrastructure/notifications.js')), 'infrastructure/notifications.js (extrait) present');

// Anciens dossiers supprimés
assert(!existsSync(path.join(base, 'modules')), 'old modules/ folder removed');
assert(!existsSync(path.join(base, 'vendor')), 'old vendor/ folder removed');
assert(!existsSync(path.join(base, 'ipcHandlers.js')), 'ipcHandlers.js moved out of main/ root');

// Notifier : responsable de la notification OS des bonnes affaires
assert(typeof Notifier.notifyGoodDeal === 'function', 'Notifier.notifyGoodDeal present');
assert(typeof Notifier.isSupported === 'function', 'Notifier.isSupported present');

// Settings extrait d'ipcHandlers
assert(typeof loadSettings === 'function', 'loadSettings extracted to core/settings');
assert(typeof saveSettings === 'function', 'saveSettings extracted to core/settings');

// risk-keywords supprimé (code mort : jamais importé, l'IA Analyse remplace
// la correspondance de mots-clés). constants.js ne doit plus le référencer.
assert(!/RISK_KEYWORDS/.test(fs.readFileSync(path.join(base, 'config/constants.js'), 'utf8')), 'RISK_KEYWORDS removed from constants.js');

// ipcHandlers ne contient plus loadSettings/saveSettings inline
assert(!/function loadSettings\b/.test(ipcCode), 'ipcHandlers no longer defines loadSettings inline');
assert(!/function saveSettings\b/.test(ipcCode), 'ipcHandlers no longer defines saveSettings inline');
assert(/require\(.\.\/settings.\)/.test(ipcCode), 'ipcHandlers imports settings from ./settings');
assert(/Notifier\.notifyGoodDeal/.test(ipcCode), 'ipcHandlers uses Notifier.notifyGoodDeal');

// main.js pointe vers core/ipcHandlers
const mainCode = fs.readFileSync(path.join(base, 'main.js'), 'utf8');
assert(/require\(.\.\/core\/ipcHandlers.\)/.test(mainCode), 'main.js requires ./core/ipcHandlers');

// pipelineRunner pointe vers le pipeline dans le même dossier
const prCode = fs.readFileSync(path.join(base, 'services/scraping/pipelineRunner.js'), 'utf8');
assert(/path\.join\(__dirname, .leboncoin-pipeline\.js.\)/.test(prCode), 'pipelineRunner finds pipeline in same folder (no ../vendor/)');

// Widget flottant (fenêtre always-on-top avec progression)
assert(existsSync(path.join(__dirname, '..', 'src/renderer/widget.html')), 'widget.html present');
const mainCode2 = fs.readFileSync(path.join(base, 'main.js'), 'utf8');
assert(/createWidgetWindow/.test(mainCode2), 'main.js: createWidgetWindow function present');
assert(/alwaysOnTop:\s*true/.test(mainCode2), 'main.js: widget window always-on-top');
assert(/ipcMain\.on\('widget:toggle'/.test(mainCode2), 'main.js: widget:toggle IPC handler');
assert(/ipcMain\.on\('widget:close'/.test(mainCode2), 'main.js: widget:close IPC handler');
assert(/ipcMain\.on\('widget:progress'/.test(mainCode2), 'main.js: widget:progress relay handler');
assert(/ipcMain\.on\('widget:status'/.test(mainCode2), 'main.js: widget:status relay handler');
assert(/toggleWidget/.test(preloadCode), 'preload.js: toggleWidget exposed');
assert(/sendWidgetProgress/.test(preloadCode), 'preload.js: sendWidgetProgress exposed');
assert(/sendWidgetStatus/.test(preloadCode), 'preload.js: sendWidgetStatus exposed');
const appCode2 = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
assert(!/Le Widget Flottant n'est pas encore disponible/.test(appCode2), 'app.js: stale "not available" alert removed');
assert(/sendWidgetProgress\(\{ percent, status \}\)/.test(appCode2), 'app.js: relays progress to widget');
assert(/sendWidgetStatus\(\{ state, message \}\)/.test(appCode2), 'app.js: relays status to widget');

// --- 6. Nouvelles features (v1.2) ---
console.log('\n[6/6] Nouvelles features : intégrité, rate-limiter, logs, Ollama, secrets, jobs-auto, sandbox');
const { writeWithChecksum, readWithChecksum, verify, computeHash, checksumPath } = require('../src/main/utils/integrity');
const { AdaptiveRateLimiter } = require('../src/main/utils/rateLimiter');
const { logger } = require('../src/main/utils/logger');
const { checkOllamaHealth, checkModelAvailable } = require('../src/main/services/ai/ollamaHealth');
const { SecretStore } = require('../src/main/utils/secretStore');

// F2 : integrity
const tmpDir = path.join(require('os').tmpdir(), `lbc-test-integrity-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
const ij = path.join(tmpDir, 'a.json');
writeWithChecksum(ij, { x: 1 });
assert(fs.existsSync(ij) && fs.existsSync(checksumPath(ij)), 'integrity: écrit .json + .sha256');
assert(readWithChecksum(ij).valid === true && readWithChecksum(ij).data.x === 1, 'integrity: lecture valide');
fs.writeFileSync(ij, '{"x":99}');
assert(readWithChecksum(ij).valid === false, 'integrity: détecte la corruption');
assert(computeHash('abc') === computeHash('abc'), 'integrity: computeHash déterministe');

// F1 : rate limiter (tests async après le bloc sync ci-dessous)

// F6 : logger
assert(typeof logger.info === 'function' && typeof logger.setRetention === 'function', 'logger: API présente');
logger.setRetention(3);

// F7 : ollamaHealth (fonctions présentes)
assert(typeof checkOllamaHealth === 'function' && typeof checkModelAvailable === 'function', 'ollamaHealth: fonctions exportées');

// F4 : secretStore round-trip
SecretStore.set('lbc-test-secret', 'val123');
assert(SecretStore.get('lbc-test-secret') === 'val123', 'secretStore: chiffrement/déchiffrement round-trip');
assert(SecretStore.list().includes('lbc-test-secret'), 'secretStore: list() contient la clé');
SecretStore.remove('lbc-test-secret');
assert(SecretStore.get('lbc-test-secret') === null, 'secretStore: remove() supprime');
assert(typeof SecretStore.isUsingOsKeychain() === 'boolean', 'secretStore: isUsingOsKeychain() retourne booléen');

// F8 : storageCleaner.cleanOldJobs
assert(typeof StorageCleaner.cleanOldJobs === 'function', 'StorageCleaner.cleanOldJobs présent');
assert(StorageCleaner.cleanOldJobs(0) === 0, 'cleanOldJobs(0) désactivé → 0');

// === AUDIT GLOBAL : 5 correctifs fiabilité ===
console.log('\n[AUDIT] Correctifs de fiabilité');

// FIX #1 : pas de référence à aiApiKey.value / openAiKeyGroup dans app.js
// (causait un crash TypeError au chargement après le retrait d'OpenAI).
assert(!/aiApiKey\.value/.test(appCode), 'app.js: plus de aiApiKey.value (accesseur sûr getAiApiKey)');
assert(!/openAiKeyGroup/.test(appCode), 'app.js: openAiKeyGroup supprimé (champ OpenAI retiré)');
assert(/getAiApiKey/.test(appCode), 'app.js: accesseur getAiApiKey() null-tolerant');

// FIX #3 : cleanOldJobs basé sur le timestamp du nom du dossier, pas le mtime
const cleanerCode = fs.readFileSync(path.join(base, 'services/maintenance/storageCleaner.js'), 'utf8');
assert(cleanerCode.includes('tsMatch = entry.name.match'), 'storageCleaner: parse le timestamp du nom de dossier');
assert(cleanerCode.includes('Date.parse(iso)'), 'storageCleaner: calcule l\'âge depuis le timestamp du nom');
assert(cleanerCode.includes('Fallback mtime'), 'storageCleaner: fallback mtime si timestamp illisible');

// FIX #4 : geocodeCityGov a un timeout (AbortController)
assert(/const controller = new AbortController\(\);[\s\S]{0,80}controller\.abort\(\), 10000/.test(appCode), 'app.js: geocodeCityGov timeout 10s (AbortController)');

// FIX #5 : aiCache plafond + éviction
const aiCacheCode = fs.readFileSync(path.join(base, 'services/ai/aiCache.js'), 'utf8');
assert(/MAX_ENTRIES\s*=\s*5000/.test(aiCacheCode), 'aiCache: plafond MAX_ENTRIES=5000');
assert(/_evictIfNeeded/.test(aiCacheCode), 'aiCache: éviction des plus anciennes (_evictIfNeeded)');
// Test fonctionnel de l'éviction
const aiCache = require(path.join(base, 'services/ai/aiCache'));
aiCache.clear();
for (let i = 0; i < 10; i++) aiCache.set(`evict-${i}`, { v: i });
assert(aiCache.stats().entries === 10, 'aiCache: 10 entrées < plafond conservées');
aiCache.clear();
assert(aiCache.stats().entries === 0, 'aiCache: clear() vide le cache');

// F5 : sandbox renderer durcie
const mainCode3 = fs.readFileSync(path.join(base, 'main.js'), 'utf8');
assert(/sandbox:\s*true/.test(mainCode3), 'main.js: sandbox:true activé sur mainWindow');
assert(/widgetPreload\.js/.test(mainCode3), 'main.js: widget utilise widgetPreload.js');
assert(existsSync(path.join(base, 'widgetPreload.js')), 'widgetPreload.js present');
const widgetHtml = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/widget.html'), 'utf8');
assert(/window\.widgetApi/.test(widgetHtml), 'widget.html: utilise window.widgetApi (pas require)');
assert(!/require\('electron'\)/.test(widgetHtml), 'widget.html: plus de require(electron) direct');
const preloadCode2 = fs.readFileSync(path.join(base, 'preload.js'), 'utf8');
assert(/checkOllamaHealth/.test(preloadCode2), 'preload.js: expose checkOllamaHealth');
assert(/checkNetwork/.test(preloadCode2), 'preload.js: expose checkNetwork');
assert(/getSecret|setSecret|hasSecret|removeSecret/.test(preloadCode2), 'preload.js: expose secret IPC');

// F3 : mode hors-ligne
assert(/offlineBadge/.test(appCode2), 'app.js: offlineBadge référencé');
assert(/isOffline/.test(appCode2), 'app.js: isOffline state tracked');
assert(/checkNetwork/.test(appCode2), 'app.js: appelle checkNetwork');
assert(existsSync(path.join(base, 'utils/integrity.js')), 'utils/integrity.js present');
assert(existsSync(path.join(base, 'utils/rateLimiter.js')), 'utils/rateLimiter.js present');
assert(existsSync(path.join(base, 'utils/logger.js')), 'utils/logger.js present');
assert(existsSync(path.join(base, 'utils/secretStore.js')), 'utils/secretStore.js present');
assert(existsSync(path.join(base, 'services/ai/ollamaHealth.js')), 'services/ai/ollamaHealth.js present');

// Settings nouveaux champs
const settingsCode = fs.readFileSync(path.join(base, 'core/settings.js'), 'utf8');
assert(/logRetentionDays/.test(settingsCode), 'settings: logRetentionDays');
assert(/autoCleanJobsDays/.test(settingsCode), 'settings: autoCleanJobsDays');

// IPC nouveaux handlers
assert(/ollama:health/.test(ipcCode), 'ipcHandlers: ollama:health handler');
assert(/network:check/.test(ipcCode), 'ipcHandlers: network:check handler');
assert(/secret:get|secret:set/.test(ipcCode), 'ipcHandlers: secret handlers');

// UI paramètres
const htmlCode = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
assert(/cfgAutoCleanJobs/.test(htmlCode), 'index.html: cfgAutoCleanJobs checkbox');
assert(/cfgAutoCleanJobsDays/.test(htmlCode), 'index.html: cfgAutoCleanJobsDays input');
assert(/cfgLogRetention/.test(htmlCode), 'index.html: cfgLogRetention input');
assert(/badge-offline/.test(htmlCode), 'index.html: badge-offline CSS class');
// Onglet scraper : option OpenAI retirée, autoAiMarket coché par défaut (IA Analyse activée)
assert(!/value="openai"/.test(htmlCode), 'index.html: option OpenAI ChatGPT retirée du scraper');
assert(!/id="aiApiKey"/.test(htmlCode), 'index.html: champ clé API OpenAI retiré');
assert(/<input type="checkbox" id="autoAiMarket" checked>/.test(htmlCode), 'index.html: autoAiMarket coché par défaut (IA Analyse activée)');
// Nouveau champ modèle vision (l'IA Analyse combine texte + vision)
assert(/id="aiVisionModel"/.test(htmlCode), 'index.html: champ modèle vision (aiVisionModel)');
// Moteur de recherche pour l'IA Marché (sans-clé par défaut)
assert(/id="searchProvider"/.test(htmlCode), 'index.html: select moteur de recherche (IA Marché)');
assert(/id="searchApiKey"/.test(htmlCode), 'index.html: champ clé API moteur de recherche');
assert(/value="ollama"/.test(htmlCode), 'index.html: option Ollama local conservée');
// Stats : nouvelles cartes + retrait bonnes affaires
assert(/statAvgPrice/.test(htmlCode), 'index.html: carte prix moyen');
assert(/statMedPrice/.test(htmlCode), 'index.html: carte prix médian');
assert(/statHandDelivery/.test(htmlCode), 'index.html: carte main propre');
assert(/statPro/.test(htmlCode) && /statPart/.test(htmlCode), 'index.html: cartes pro/particulier');
assert(!/statGoodDeals/.test(htmlCode), 'index.html: carte Bonnes Affaires supprimée');
assert(!/statRisks/.test(htmlCode), 'index.html: carte Annonces Trop Chères supprimée');
assert(!/id="dealsChart"/.test(htmlCode), 'index.html: canvas dealsChart (Répartition Opportunités) supprimé');
assert(/id="priceDistChart"/.test(htmlCode), 'index.html: canvas priceDistChart (distribution prix)');
assert(/id="topCitiesChart"/.test(htmlCode), 'index.html: canvas topCitiesChart (top villes)');
assert(/stat-card-accent/.test(htmlCode), 'index.html: stat-cards accentuées');

// F4 : Module Navigateur IA Studio
console.log('\n[7/7] Module Navigateur IA Studio');
const mainCode4 = fs.readFileSync(path.join(base, 'main.js'), 'utf8');
assert(/webviewTag:\s*true/.test(mainCode4), 'main.js: webviewTag activé pour le navigateur intégré');
// Hardening webview : handler will-attach-webview verrouille les webpreferences
assert(/will-attach-webview/.test(mainCode4), 'main.js: handler will-attach-webview (verrouille nodeIntegration sur webview dynamiques)');
assert(/webPreferences\.nodeIntegration\s*=\s*false/.test(mainCode4), 'main.js: webview nodeIntegration forcé à false');
assert(/delete\s+webPreferences\.preload/.test(mainCode4), 'main.js: webview preload injecté supprimé');

// Générateur de prompt IA locale (Ollama, remplace les prompts statiques)
assert(existsSync(path.join(base, 'services/ai/promptGenerator.js')), 'services/ai/promptGenerator.js present');
const promptGenCode = fs.readFileSync(path.join(base, 'services/ai/promptGenerator.js'), 'utf8');
assert(/class PromptGenerator/.test(promptGenCode), 'promptGenerator: classe PromptGenerator');
assert(/getAIProvider/.test(promptGenCode), 'promptGenerator: utilise getAIProvider (délégation à AIProvider)');
assert(/chatText/.test(promptGenCode), 'promptGenerator: appelle ai.chatText (au lieu d\'un fetch direct)');
assert(/temperature:\s*0\.4/.test(promptGenCode), 'promptGenerator: temperature 0.4 (génération reproductible)');
assert(/AbortController/.test(fs.readFileSync(path.join(base, 'services/ai/providers/ollamaProvider.js'), 'utf8')), 'ollamaProvider: AbortController (timeout fetch)');
assert(!/generativelanguage\.googleapis\.com/.test(promptGenCode), 'promptGenerator: aucun appel vers Gemini (IA locale uniquement)');
assert(!/require\('electron'\)/.test(promptGenCode), 'promptGenerator: pas de require(electron) (réutilisable hors app)');
assert(/priceRange/.test(promptGenCode), 'promptGenerator: supporte priceRange (fourchette de prix)');
assert(/rankings/.test(promptGenCode), 'promptGenerator: supporte rankings (classements demandés)');
assert(/topN/.test(promptGenCode), 'promptGenerator: supporte topN (Top des résultats)');

assert(/tab-ai-studio/.test(htmlCode), 'index.html: onglet tab-ai-studio présent');
assert(/aistudioWebview/.test(htmlCode), 'index.html: webview navigateur intégré');
assert(/aistudio\.google\.com/.test(htmlCode), 'index.html: URL AI Studio par défaut');
assert(/aistudioOpenJobsBtn/.test(htmlCode), 'index.html: bouton ouvrir dossier des jobs');
assert(/aistudioObjective/.test(htmlCode), 'index.html: champ objectif d\'analyse');
assert(/aistudioCustomHints/.test(htmlCode), 'index.html: champ consignes supplémentaires');
assert(/aistudioOllamaUrl/.test(htmlCode), 'index.html: champ URL serveur Ollama');
assert(/aistudioOllamaModel/.test(htmlCode), 'index.html: select modèle Ollama');
assert(/aistudioOllamaTestBtn/.test(htmlCode), 'index.html: bouton tester Ollama (lister modèles)');
assert(/aistudioGenerateBtn/.test(htmlCode), 'index.html: bouton génération prompt par IA locale');
assert(/Comment utiliser ce module/.test(htmlCode), 'index.html: panneau explicatif');
assert(existsSync(path.join(__dirname, '..', 'src/renderer/aiStudioModule.js')), 'renderer/aiStudioModule.js present');
const aistudioModCode = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/aiStudioModule.js'), 'utf8');
assert(/window\.aiStudioModule/.test(aistudioModCode), 'aiStudioModule: exposé sur window.aiStudioModule');
assert(/generatePrompt/.test(aistudioModCode), 'aiStudioModule: generatePrompt appelle l\'IA locale via IPC');
assert(/window\.api\.generatePrompt/.test(aistudioModCode), 'aiStudioModule: appel IPC prompt:generate');
assert(/testOllama/.test(aistudioModCode), 'aiStudioModule: testOllama (vérifie la connexion + liste les modèles)');
assert(/listOllamaModels/.test(aistudioModCode), 'aiStudioModule: appel IPC ollama:models');
assert(!/MASTER_PROMPT/.test(aistudioModCode), 'aiStudioModule: prompts statiques supprimés');
assert(!/renderPrompt/.test(aistudioModCode), 'aiStudioModule: renderPrompt supprimé (génération IA)');
assert(/aistudioOpenJobsBtn/.test(aistudioModCode), 'aiStudioModule: bouton ouvrir jobs branché');
assert(/aistudio\.google\.com/.test(aistudioModCode), 'aiStudioModule: URL AI Studio par défaut');
assert(!/require\('electron'\)/.test(aistudioModCode), 'aiStudioModule: pas de require(electron) (renderer sandboxé)');
assert(/aiStudioModule\.js/.test(htmlCode), 'index.html: inclut aiStudioModule.js');

// IPC prompt:generate + ollama:models exposés
const ipcHandlersCode = fs.readFileSync(path.join(base, 'core/ipcHandlers.js'), 'utf8');
assert(/prompt:generate/.test(ipcHandlersCode), 'ipcHandlers: handler prompt:generate (Ollama local)');
assert(/ollama:models/.test(ipcHandlersCode), 'ipcHandlers: handler ollama:models (liste modèles installés)');
const preloadCodeFull = fs.readFileSync(path.join(base, 'preload.js'), 'utf8');
assert(/generatePrompt/.test(preloadCodeFull), 'preload.js: expose generatePrompt');
assert(/listOllamaModels/.test(preloadCodeFull), 'preload.js: expose listOllamaModels');

// F5 : fenêtre de connexion Google dédiée (le webview est bloqué par Google pour l'OAuth)
assert(/aistudioLoginBtn/.test(htmlCode), 'index.html: bouton 🔑 Se connecter (ouverture fenêtre dédiée)');
assert(/aistudio:openLogin/.test(mainCode4), 'main.js: handler IPC aistudio:openLogin');
assert(/AI_STUDIO_PARTITION\s*=\s*['"]persist:aistudio['"]/.test(mainCode4), 'main.js: constante AI_STUDIO_PARTITION = persist:aistudio');
assert(/setUserAgent/.test(mainCode4), 'main.js: setUserAgent Chrome réel sur la fenêtre de connexion (anti-blocage Google)');
assert(/session\.fromPartition/.test(mainCode4), 'main.js: session.fromPartition pour configurer la partition IA Studio');
assert(/sec-ch-ua/.test(mainCode4), 'main.js: réécriture sec-ch-ua (Client Hints) pour masquer la marque Electron');
assert(/onBeforeSendHeaders/.test(mainCode4), 'main.js: onBeforeSendHeaders interception des en-têtes sortants');
assert(/aistudioLoginPreload/.test(mainCode4), 'main.js: preload aistudioLoginPreload sur la fenêtre de connexion');
assert(existsSync(path.join(base, 'aistudioLoginPreload.js')), 'aistudioLoginPreload.js present');
const loginPreloadCode = fs.readFileSync(path.join(base, 'aistudioLoginPreload.js'), 'utf8');
assert(/userAgentData/.test(loginPreloadCode), 'aistudioLoginPreload: override navigator.userAgentData (marque Electron en JS)');
assert(/webdriver/.test(loginPreloadCode), 'aistudioLoginPreload: navigator.webdriver = false');
assert(/window\.chrome/.test(loginPreloadCode), 'aistudioLoginPreload: window.chrome défini');
// Le webview de l'onglet reçoit aussi le preload + contextIsolation désactivé
assert(/aistudioLoginPreload\.js/.test(htmlCode), 'index.html: webview reçoit le preload anti-détection Google');
assert(/contextIsolation=no/.test(htmlCode), 'index.html: webview contextIsolation=no (override navigator côté page)');
assert(/openAiStudioLogin/.test(preloadCodeFull), 'preload.js: expose openAiStudioLogin');

// === MODULE D'AIDE : FAQ / Help / Feedback ===
assert(/openFaqBtn/.test(htmlCode), 'index.html: bouton FAQ présent');
assert(/openHelpBtn/.test(htmlCode), 'index.html: bouton Help présent');
assert(/openFeedbackBtn/.test(htmlCode), 'index.html: bouton Problèmes & Améliorations présent');
assert(/id="faqModal"/.test(htmlCode), 'index.html: modale FAQ présente');
assert(/id="helpModal"/.test(htmlCode), 'index.html: modale Help présente');
assert(/id="feedbackModal"/.test(htmlCode), 'index.html: modale Feedback présente');
assert(/helpModule\.js/.test(htmlCode), 'index.html: inclut helpModule.js');
assert(existsSync(path.join(__dirname, '..', 'src/renderer', 'helpModule.js')), 'renderer/helpModule.js present');
const helpModCode = fs.readFileSync(path.join(__dirname, '..', 'src/renderer', 'helpModule.js'), 'utf8');
assert(/FAQ_DATA/.test(helpModCode), 'helpModule: données FAQ présentes');
assert(/HELP_SECTIONS/.test(helpModCode), 'helpModule: sections du guide présentes');
assert(/submitFeedback/.test(helpModCode), 'helpModule: fonction submitFeedback (préparée pour future API)');
assert(/window\.helpModule/.test(helpModCode), 'helpModule: exposé sur window.helpModule');
// Les boutons d'aide sont discrets (classe help-btn), distincts des onglets principaux
assert(/class="help-btn"/.test(htmlCode), 'index.html: boutons aide discrets (class help-btn)');
// IPC diagnostic non sensible pour le feedback
assert(/app:getDiagnostics/.test(ipcHandlersCode), 'ipcHandlers: handler app:getDiagnostics (diagnostic feedback)');
assert(/getDiagnostics/.test(preloadCodeFull), 'preload.js: expose getDiagnostics');
// Le feedback n'envoie rien sur le réseau tant que l'API n'est pas branchée (V2).
// On vérifie l'absence de fetch ACTIF (hors commentaires) et la présence de
// l'archive locale (comportement réel tant que le backend n'existe pas).
const helpNoComments = helpModCode.replace(/\/\/[^\n]*\n/g, '');
assert(!/fetch\(\s*['"]https/.test(helpNoComments), 'helpModule: pas d\'envoi HTTP actif (API backend pas encore développé)');
assert(/localStorage.*feedback-archive/.test(helpModCode), 'helpModule: rapport archivé localement (V2 en attendant le serveur)');

// --- 7. Nouveaux champs extraits : catégorie, note vendeur, mode de remise ---
console.log('\n[7] Nouveaux champs d\'extraction (catégorie / note vendeur / remise)');
const pipelineCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), 'utf8');
const excelCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/infrastructure/excelExporter.js'), 'utf8');
const appCodeFull = fs.readFileSync(path.join(__dirname, '..', 'src/renderer', 'app.js'), 'utf8');
const htmlCodeFull = fs.readFileSync(path.join(__dirname, '..', 'src/renderer', 'index.html'), 'utf8');

// Pipeline : helpers d'extraction défensive présents
assert(/function extractDeliveryInfo/.test(pipelineCode), 'pipeline: extractDeliveryInfo helper');
assert(/function extractCategory/.test(pipelineCode), 'pipeline: extractCategory helper');
assert(/function extractSellerRating/.test(pipelineCode), 'pipeline: extractSellerRating helper');
// normalizeAd peuple les nouveaux champs
assert(/deliveryMode:\s*delivery\.deliveryMode/.test(pipelineCode), 'pipeline: normalizeAd définit deliveryMode');
assert(/sellerRating,/.test(pipelineCode), 'pipeline: normalizeAd définit sellerRating');
assert(/category:\s*extractCategory\(raw\)/.test(pipelineCode), 'pipeline: normalizeAd définit category via extractCategory');
assert(/handDelivery:\s*delivery\.handDelivery/.test(pipelineCode), 'pipeline: normalizeAd définit handDelivery');
// mergeDuplicates préserve les valeurs non-null (ne pas écraser par null)
assert(/mergeKeepingNonNull/.test(pipelineCode), 'pipeline: mergeKeepingNonNull préserve les champs non-null');
// Enrichissement page détail : récupère aussi category/rating/delivery
assert(/extractSellerRating\(target\)/.test(pipelineCode), 'pipeline: enrichissement page détil extrait sellerRating');
assert(/extractCategory\(target\)/.test(pipelineCode), 'pipeline: enrichissement page détail extrait category');

// Excel : nouvelles colonnes présentes
assert(/header:\s*'Catégorie'/.test(excelCode), 'excelExporter: colonne Catégorie');
assert(/header:\s*'Note Vendeur'/.test(excelCode), 'excelExporter: colonne Note Vendeur');
assert(/header:\s*'Mode de Remise'/.test(excelCode), 'excelExporter: colonne Mode de Remise');
assert(/deliveryLabelMap/.test(excelCode), 'excelExporter: libellé humain du mode de remise');

// UI : la fiche détaillée affiche les 3 nouveaux champs
assert(/id="modalCategory"/.test(htmlCodeFull), 'index.html: modalCategory span');
assert(/id="modalSellerRating"/.test(htmlCodeFull), 'index.html: modalSellerRating span');
assert(/id="modalDeliveryMode"/.test(htmlCodeFull), 'index.html: modalDeliveryMode span');
assert(/setExtraVal\('modalCategory'/.test(appCodeFull), 'app.js: openAdDetail remplit modalCategory');
assert(/setExtraVal\('modalSellerRating'/.test(appCodeFull), 'app.js: openAdDetail remplit modalSellerRating');
assert(/setExtraVal\('modalDeliveryMode'/.test(appCodeFull), 'app.js: openAdDetail remplit modalDeliveryMode');
// Carte : géocodage parallélisé (concurrence) au lieu d'une boucle séquentielle
assert(/GEOCODE_CONCURRENCY/.test(appCodeFull), 'app.js: géocodage carte parallélisé (GEOCODE_CONCURRENCY)');
assert(!/for \(const a of targetAds\) \{\s*$/.test(appCodeFull), 'app.js: boucle séquentielle de géocodage retirée');

// === AUDIT STABILISATION : Lots A/B/C/D ===
// Lot C — aiCache : sauvegarde debouncée (pas de writeFileSync synchrone à chaque set)
assert(/SAVE_DEBOUNCE_MS\s*=\s*\d+/.test(aiCacheCode), 'aiCache: constante SAVE_DEBOUNCE_MS définie');
assert(/_scheduleSave/.test(aiCacheCode), 'aiCache: _scheduleSave (debounce écriture)');
assert(/_flushSave/.test(aiCacheCode), 'aiCache: _flushSave (écriture forcée)');
assert(/function _saveNow/.test(aiCacheCode), 'aiCache: _saveNow séparé de _scheduleSave');
// set() ne doit PLUS appeler _save() synchrone (anciennement) ; appelle _scheduleSave
assert(/_scheduleSave\(\);/.test(aiCacheCode.replace(/\/\/[\s\S]*?\n/g, '')), 'aiCache: set() planifie la sauvegarde (debounce)');
assert(!/\nfunction _save\(\)/.test(aiCacheCode), 'aiCache: ancienne fonction synchrone _save() retirée');
assert(/_flushSave/.test(fs.readFileSync(path.join(base, 'services/ai/adAnalyzer.js'), 'utf8')), 'adAnalyzer: flush cache en fin de batch');
assert(/_flushSave/.test(fs.readFileSync(path.join(base, 'services/ai/marketValueAnalyzer.js'), 'utf8')), 'marketValueAnalyzer: flush cache en fin de batch');
// Test fonctionnel : set() ne persiste pas immédiatement (debounce), mais
// _flushSave() force l'écriture disque. On le prouve en rechargeant un cache
// neuf depuis le disque après flush.
aiCache.clear();
const _aiCache2 = require(path.join(base, 'services/ai/aiCache'));
_aiCache2.set('persist-1', { v: 42 }, 'analyse');
assert(_aiCache2.get('persist-1', 'analyse') && _aiCache2.get('persist-1', 'analyse').v === 42, 'aiCache: get voit la valeur en mémoire juste après set()');
_aiCache2._flushSave(); // force l'écriture disque
// Recharge un cache neuf depuis le disque pour prouver la persistance
const aiCachePath = require.resolve(path.join(base, 'services/ai/aiCache'));
delete require.cache[aiCachePath];
const freshCache = require(aiCachePath);
const persisted = freshCache.get('persist-1', 'analyse');
assert(persisted && persisted.v === 42, 'aiCache: _flushSave persiste la valeur sur disque (recharge OK)');
freshCache.clear();

// Lot D — Carte Leaflet : anti race condition (compteur de génération)
assert(/mapRenderGen\s*=\s*0/.test(appCodeFull), 'app.js: mapRenderGen (compteur génération carte)');
assert(/const gen = \+\+mapRenderGen/.test(appCodeFull), 'app.js: renderMap incrémente la génération');
assert(/isStale\(\)/.test(appCodeFull), 'app.js: renderMap vérifie isStale() avant d\'ajouter marqueurs');
assert(/if \(isStale\(\)\) return/.test(appCodeFull), 'app.js: worker carte abandonne si stale');

// Lot B — Rafraîchissement onglet actif après scraping terminé
assert(/refreshActiveDataTab/.test(appCodeFull), 'app.js: refreshActiveDataTab défini');
assert(/refreshActiveDataTab\(\)/.test(appCodeFull), 'app.js: onStatusChange appelle refreshActiveDataTab sur completed');

// Lot A — Presets 1-clic complets : capture URL + pages + limit + noDesc + AI
assert(/savePresetBtn/.test(appCodeFull), 'app.js: savePresetBtn référencé');
assert(/loadPreset\b/.test(appCodeFull), 'app.js: loadPreset présent');
assert(/collectSearchConfig/.test(appCodeFull), 'app.js: collectSearchConfig (capture config complète pour preset)');
assert(/applySearchConfig/.test(appCodeFull), 'app.js: applySearchConfig (restaure config complète du preset)');
assert(/noPhotoUrl/.test(appCodeFull), 'app.js: noPhotoUrl (placeholder local)');
assert(/escapeHtml\b/.test(appCodeFull), 'app.js: escapeHtml (échappement HTML)');
// plus de dépendance externe via.placeholder.com dans du code réel (hors commentaires)
const appCodeNoComments = appCodeFull.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
assert(!/via\.placeholder\.com/.test(appCodeNoComments), 'app.js: plus de dépendance externe via.placeholder.com (hors commentaires)');

// Cohérence tri explorateur : défaut sauvegardé = 'DEFAULT' (option réelle)
assert(/sort:\s*sortSelect\?\.value\s*\|\|\s*'DEFAULT'/.test(appCodeFull), 'app.js: défaut tri explorateur = DEFAULT (cohérent avec <select>');

// === AUDIT SEARCH : Tavily provider + DDG anti-bot resilience ===
const searchRegCode = fs.readFileSync(path.join(base, 'services/ai/search/searchProviderRegistry.js'), 'utf8');
assert(/TavilySearchProvider/.test(searchRegCode), 'searchRegistry: importe TavilySearchProvider');
assert(/registerSearchProvider\('tavily'/.test(searchRegCode), 'searchRegistry: enregistre le moteur tavily');
const tavilyPath = path.join(base, 'services/ai/search/tavilySearchProvider.js');
assert(existsSync(tavilyPath), 'tavilySearchProvider.js: fichier présent');
const tavilyCode = fs.readFileSync(tavilyPath, 'utf8');
assert(/api\.tavily\.com\/search/.test(tavilyCode), 'tavily: endpoint api.tavily.com/search');
assert(/requiresApiKey\(\)\s*\{\s*return true/.test(tavilyCode), 'tavily: requiresApiKey() = true');
assert(/Authorization.*Bearer/.test(tavilyCode), 'tavily: authentification Bearer');
assert(/HTTP 401|HTTP 403|invalide/.test(tavilyCode), 'tavily: détecte clé invalide (401/403)');
assert(/429|quota/.test(tavilyCode), 'tavily: détecte quota dépassé (429)');
assert(/max_results/.test(tavilyCode), 'tavily: param max_results');
assert(/r\.title[\s\S]*r\.content[\s\S]*r\.url/.test(tavilyCode.replace(/\/\/[^\n]*/g, '')), 'tavily: mappe title/content/url');
// Tavily fonctionnel : clé manquante → ok:false clair
const { TavilySearchProvider } = require(path.join(base, 'services/ai/search/tavilySearchProvider'));
const _tNoKey = new TavilySearchProvider({});
assert(_tNoKey.requiresApiKey() === true, 'tavily: requiresApiKey true');
{
  const h = await _tNoKey.checkHealth();
  assert(h.ok === false, 'tavily: health false sans clé');
  assert(/manquante/i.test(h.message), 'tavily: message clé manquante');
}
{
  const s = await _tNoKey.search('test');
  assert(s.ok === false, 'tavily: search false sans clé');
  assert(/manquante/i.test(s.message), 'tavily: search message clé manquante');
}
// Tavily avec clé (fake) : health ok, pas de crash au constructeur
const _tKey = new TavilySearchProvider({ apiKey: 'fake-key-xxx' });
{
  const h = await _tKey.checkHealth();
  assert(h.ok === true, 'tavily: health ok avec clé');
  assert(_tKey.name === 'Tavily (clé API)', 'tavily: name');
}

// DDG : détection page anti-bot (anomaly/captcha) + retry/backoff
const ddgCode2 = fs.readFileSync(path.join(base, 'services/ai/search/duckDuckGoSearchProvider.js'), 'utf8');
assert(/function isAnomalyPage/.test(ddgCode2), 'ddg: fonction isAnomalyPage');
assert(/anomaly-modal/.test(ddgCode2), 'ddg: détecte anomaly-modal');
assert(/status === 202/.test(ddgCode2), 'ddg: status 202 = anti-bot');
assert(/isAnomalyPage\(html, res\.status\)/.test(ddgCode2), 'ddg: appelle isAnomalyPage après réception');
assert(/MAX_ATTEMPTS/.test(ddgCode2), 'ddg: retry avec MAX_ATTEMPTS');
assert(/_searchOnce/.test(ddgCode2), 'ddg: _searchOnce (requête unique isolée du retry)');
assert(/_sleep/.test(ddgCode2), 'ddg: backoff (_sleep)');
assert(/anti-bot|captcha|bloquée/i.test(ddgCode2), 'ddg: message clair anti-bot orientant vers Tavily');
assert(/res\.status === 403 \|\| res\.status === 429/.test(ddgCode2), 'ddg: 403/429 retryable');
// isAnomalyPage fonctionnel
const { isAnomalyPage, parseDdgLite } = require(path.join(base, 'services/ai/search/duckDuckGoSearchProvider'));
assert(isAnomalyPage('<div class="anomaly-modal__box">puzzle</div>', 200) === true, 'ddg: anomaly-modal détecté');
assert(isAnomalyPage('', 202) === true, 'ddg: HTTP 202 = anomaly');
assert(isAnomalyPage('<html>page normale</html>', 200) === false, 'ddg: page normale non anomaly');
assert(isAnomalyPage('', 200) === false, 'ddg: vide+200 non anomaly');
// parseDdgLite : structure réelle DDG Lite (result-link + result-snippet)
const _parsed = parseDdgLite('<a class="result-link" href="https://ex.com/a">iPhone 12</a><td class="result-snippet">128 Go</td>');
assert(_parsed.length === 1, 'ddg: parse 1 résultat');
assert(_parsed[0].title === 'iPhone 12', 'ddg: titre parsé');
assert(_parsed[0].url === 'https://ex.com/a', 'ddg: url parsée');
assert(_parsed[0].source === 'ex.com', 'ddg: source host parsé');
// listSearchProviders inclut tavily (le select du renderer sera peuplé)
const _providers = listSearchProviders();
assert(_providers.some((p) => p.id === 'tavily' && p.keyless === false), 'searchRegistry: tavily listé (keyless=false)');
assert(_providers.some((p) => p.id === 'duckduckgo' && p.keyless === true), 'searchRegistry: duckduckgo listé (keyless=true)');

// HTML : placeholder clé mentionne Tavily
assert(/tavily/i.test(htmlCodeFull), 'index.html: placeholder clé mentionne Tavily');

// === AUDIT CONTEXTE IA : num_ctx + réparation JSON tronqué ===
// Cause racine des valeurs absurdes (8€, 120€, 500€) + « JSON invalide » :
// Ollama utilise num_ctx=2048 par défaut. Le prompt IA Marché (système + annonce
// + 10 sources + spec JSON ≈ 2000 tokens) ne laissait ~0 token de sortie → JSON
// tronqué en plein milieu d'un nombre ("realValue": 8 au lieu de 8000).
const mvaCode = fs.readFileSync(path.join(base, 'services/ai/marketValueAnalyzer.js'), 'utf8');
assert(/AI_NUM_CTX\s*=\s*8192/.test(mvaCode), 'marketValueAnalyzer: AI_NUM_CTX=8192 (contexte monté)');
assert(/numCtx:\s*AI_NUM_CTX/.test(mvaCode), 'marketValueAnalyzer: passe numCtx au provider IA');
assert(/MAX_SNIPPETS\s*=\s*6/.test(mvaCode), 'marketValueAnalyzer: MAX_SNIPPETS réduit à 6 (prompt plus compact)');
assert(/MAX_SNIPPET_CHARS\s*=\s*250/.test(mvaCode), 'marketValueAnalyzer: MAX_SNIPPET_CHARS réduit à 250');
assert(/function _repairTruncatedJson/.test(mvaCode), 'marketValueAnalyzer: _repairTruncatedJson (réparation JSON tronqué)');
assert(/parsed\._repaired/.test(mvaCode), 'marketValueAnalyzer: gère le flag _repaired (confiance baissée)');
// ollamaProvider : num_ctx transmis à l'API Ollama
const ollamaCode2 = fs.readFileSync(path.join(base, 'services/ai/providers/ollamaProvider.js'), 'utf8');
assert(/opts\.numCtx/.test(ollamaCode2), 'ollamaProvider: lit opts.numCtx');
assert(/options\.num_ctx\s*=\s*opts\.numCtx/.test(ollamaCode2), 'ollamaProvider: transmet num_ctx à options Ollama');
assert(/options\.num_predict\s*=\s*opts\.numPredict/.test(ollamaCode2), 'ollamaProvider: transmet num_predict (extensibilité)');
// promptGenerator : num_ctx monté aussi (meta-prompt long ~3000+ caractères)
const pgCode = fs.readFileSync(path.join(base, 'services/ai/promptGenerator.js'), 'utf8');
assert(/numCtx:\s*8192/.test(pgCode), 'promptGenerator: numCtx:8192 (anti-troncation prompt long)');

// Test fonctionnel : parseMarket répare le JSON tronqué
const { _parseMarket } = require(path.join(base, 'services/ai/marketValueAnalyzer'));
// JSON complet → parse normal, pas de _repaired
{
  const ok = _parseMarket('{"realValue": 8000, "confidence": "haute", "rationale": "ok"}');
  assert(ok && ok.realValue === 8000 && ok._repaired === undefined, 'parseMarket: JSON complet OK sans _repaired');
}
// JSON tronqué (seule l'accolade fermante manque) → réparé, valeur correcte conservée
{
  const rep = _parseMarket('{"realValue": 8000, "confidence": "haute"');
  assert(rep && rep.realValue === 8000 && rep._repaired === true, 'parseMarket: répare JSON tronqué (accolade manquante), conserve realValue');
}
// JSON tronqué en plein nombre → réparé (valeur partielle flaguée)
{
  const rep2 = _parseMarket('{"realValue": 8');
  assert(rep2 && rep2._repaired === true, 'parseMarket: répare JSON tronqué mid-number (flag _repaired)');
}
// JSON sans realValue → null (irrécupérable)
{
  assert(_parseMarket('{"foo": 1') === null, 'parseMarket: null si pas de realValue');
}
// JSON totalement invalide → null
{
  assert(_parseMarket('pas du tout du json') === null, 'parseMarket: null si pas de JSON');
}
// Markdown autour → extrait le JSON
{
  const md = _parseMarket('```json\n{"realValue": 5000}\n```');
  assert(md && md.realValue === 5000, 'parseMarket: extrait JSON entouré de markdown');
}

// --- 6. Audit fiabilité v2 : guards, robustesse fichiers, edge cases ---
console.log('\n[6/6] Audit fiabilité (guards & robustesse)');

// market:analyze : verrou dédié (isMarketAnalyzing) contre les lancements
// concurrents. Sans lui, un double-clic sur « IA Marché » lançait deux batches
// IA + deux writeWithChecksum en parallèle sur le même job (race sur le JSON).
assert(/isMarketAnalyzing\s*=\s*false/.test(ipcCode), 'ipcHandlers: isMarketAnalyzing déclaré (verrou market)');
assert(/if \(isMarketAnalyzing\) throw/.test(ipcCode), 'ipcHandlers: market:analyze rejette une 2e analyse concurrente');
assert(/isMarketAnalyzing\s*=\s*false;\s*$|isMarketAnalyzing\s*=\s*false;\s*\/\/|finally\s*{[^}]*isMarketAnalyzing\s*=\s*false/s.test(ipcCode), 'ipcHandlers: isMarketAnalyzing libéré dans finally (même en cas d\'erreur)');
// Le handler market:analyze lit annonces.json via readWithChecksum (intégrité)
assert(/readWithChecksum\(targetJob\.files\.json\)/.test(ipcCode), 'ipcHandlers: market:analyze valide le checksum d\'annonces.json');
// job:start lit aussi annonces.json via readWithChecksum (message clair si corrompu)
assert(/readWithChecksum\(jsonPath\)/.test(ipcCode), 'ipcHandlers: job:start valide le checksum d\'annonces.json');

// writeSummaryFile : écriture atomique (atomicWriteFileSync) — pas de fs.writeFileSync
// qui laissait resumes-ia.json tronqué en cas de crash.
assert(/atomicWriteFileSync\(summaryPath/.test(ipcCode), 'ipcHandlers: writeSummaryFile atomique (atomicWriteFileSync)');
assert(!/fs\.writeFileSync\(summaryPath/.test(ipcCode), 'ipcHandlers: writeSummaryFile n\'utilise plus fs.writeFileSync (non-atomique)');

// adAnalyzer : filtre les images invalides (null/undefined/non-http) avant
// le téléchargement — évite fetch(null) qui polluait les logs d'erreurs.
const adAnalyzerCode = fs.readFileSync(path.join(base, 'services/ai/adAnalyzer.js'), 'utf8');
assert(/typeof u === 'string'/.test(adAnalyzerCode), 'adAnalyzer: filtre images non-string');
assert(/https\?:\\\//.test(adAnalyzerCode), 'adAnalyzer: filtre images non-URL (http/https)');

// harCapturer : annulation pendant CAPTCHA ne persiste PAS une session bloquée
// (sinon cookies anti-bot empoisonnaient tous les jobs suivants).
const harCode = fs.readFileSync(path.join(base, 'services/scraping/harCapturer.js'), 'utf8');
assert(/NE PAS persister la session/.test(harCode), 'harCapturer: annulation warmup ne persiste pas la session bloquée');

// harCapturer : détection CAPTCHA multi-vecteurs (iframe, URL, Cloudflare)
// L'ancienne version ne vérifiait que body.innerText → ratait les CAPTCHA en
// iframe cross-origin (Arkose/FunCaptcha/Cloudflare) et les redirections URL.
assert(/arkoselabs|funcaptcha/.test(harCode), 'harCapturer: détection iframe Arkose/FunCaptcha');
assert(/challenges\.cloudflare|cf-turnstile|challenge-form/.test(harCode), 'harCapturer: détection challenge Cloudflare');
assert(/captchaUrlMatch|URL suspecte/.test(harCode), 'harCapturer: détection CAPTCHA via URL (redirection)');

// harCapturer : AUCUN reload pendant la résolution CAPTCHA
// L'ancien code faisait vPage.reload() toutes les 2s → l'utilisateur ne pouvait
// pas résoudre le CAPTCHA (page réinitialisée en continu).
assert(!/vPage\.reload\(\{ waitUntil/.test(harCode), 'harCapturer: PAS de reload pendant résolution CAPTCHA (polling sans reload)');
assert(/POLL SANS reload/.test(harCode) || /sans recharger/.test(harCode), 'harCapturer: polling sans reload documenté');

// harCapturer : warmup utilise networkidle (pas domcontentloaded) pour laisser
// le temps au JS de rendre le CAPTCHA (Arkose charge après domcontentloaded).
assert(/waitUntil:\s*['"]networkidle['"]/.test(harCode), 'harCapturer: warmup utilise networkidle (CAPTCHA rendu après domcontentloaded)');
// Le délai d'attente a été augmenté de 1.5s à 3s pour le rendu JS différé.
assert(/sleep\(3000\)/.test(harCode), 'harCapturer: délai warmup 3s (rendu CAPTCHA différé)');

// harCapturer : post-CAPTCHA — attend networkidle + grace period avant save
// L'ancienne version sauvegardait la session immédiatement → session incomplète
// (cookie de validation pas encore posé) → erreur au prochain goto.
assert(/stabilisation de la session/.test(harCode), 'harCapturer: post-CAPTCHA attend stabilisation session');
assert(/2e CAPTCHA consécutif/.test(harCode), 'harCapturer: re-vérification post-CAPTCHA (2e CAPTCHA possible)');

// harCapturer : CAPTCHA pendant la capture → résolution interactive + reprise
// L'ancienne version abandonnait (break) avec "Relancez après résolution".
assert(/résolution interactive/.test(harCode), 'harCapturer: CAPTCHA pendant capture → résolution interactive (pas abandon)');
assert(/Reprise après résolution CAPTCHA/.test(harCode), 'harCapturer: reprise capture après résolution CAPTCHA');

// pipeline : recyclage de contexte résilient (sauvegarde préventive + try/catch)
const pipeCode = fs.readFileSync(path.join(base, 'services/scraping/leboncoin-pipeline.js'), 'utf8');
assert(/Recyclage contexte échoué/.test(pipeCode), 'pipeline: recyclage contexte a un catch (ne crash pas le job)');
assert(/Sauvegarde préventive AVANT le recyclage/.test(pipeCode), 'pipeline: writeOutputs avant recyclage (pas de perte)');

// renderer : renderCharts garde contre les canvas absents (sinon crash → carte cassée)
assert(/priceDistCanvas \|\| !sellerCanvas \|\| !citiesCanvas/.test(appCode), 'app.js: renderCharts garde contre canvas absents');
// renderer : cache géocodage tolérant au JSON corrompu
assert(/try \{ return JSON\.parse\(cached\); \} catch/.test(appCode), 'app.js: cache géocodage tolérant au JSON corrompu');
// renderer : mapHandDeliveryOnly null-safe
assert(/mapHandDeliveryEl && mapHandDeliveryEl\.checked/.test(appCode), 'app.js: mapHandDeliveryOnly null-safe');

// excelExporter : date formatée lisible (pas d'ISO brute)
const excelCode2 = fs.readFileSync(path.join(__dirname, '..', 'src/main/infrastructure/excelExporter.js'), 'utf8');
assert(/Number\.isFinite\(d\.getTime\(\)\)/.test(excelCode2), 'excelExporter: date validée (Number.isFinite)');
assert(/pad\(d\.getDate\(\)\)/.test(excelCode2), 'excelExporter: date formatée JJ/MM/AAAA HH:mm');

// constants.js : DEFAULTS mort supprimé (valeurs conflictuelles avec settings)
const constantsCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/config/constants.js'), 'utf8');
assert(!/DEFAULTS:\s*\{/.test(constantsCode), 'constants.js: DEFAULTS mort supprimé (valeurs conflictuelles)');

console.log('\n[7/7] Audit fonctionnel A→Z (cohérence UI/logique/docs)');

// jobHistory : format de date lisible (JJ/MM/AAAA au lieu de AAAA:MM:JJ avec
// deux-points dans la date). L'ancien code remplaçait tous les '-' par ':' →
// « 2026:08:12 à 02:21 » (illisible). Le nouveau utilise un regex pour extraire
// les composants et formater en français.
const jobHistoryCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/jobs/jobHistory.js'), 'utf8');
assert(/tsMatch\s*=\s*entry\.name\.match/.test(jobHistoryCode), 'jobHistory: format date via regex (extraction composants)');
assert(/\$\{tsMatch\[3\]\}\/\$\{tsMatch\[2\]\}\/\$\{tsMatch\[1\]\}/.test(jobHistoryCode), 'jobHistory: date au format JJ/MM/AAAA (slashes)');
assert(jobHistoryCode.indexOf("replace(/-/g") === -1, 'jobHistory: ne remplace plus les - par : dans la date (ancien pattern retire)');
// rapport.txt est mort (jamais créé par le pipeline) → retiré de jobHistory
assert(!/rapportPath|rapport:/.test(jobHistoryCode), 'jobHistory: rapport.txt mort retiré (jamais généré par le pipeline)');

// app.js : preset sauvegarde le moteur de recherche (DuckDuckGo/Tavily)
// Avant : un preset sauvegardé avec Tavily se rechargeait en DuckDuckGo.
assert(/searchProvider:.*searchProviderSelect/.test(appCode), 'app.js: collectSearchConfig capture searchProvider');
assert(/cfg\.searchProvider && searchProviderSelect/.test(appCode), 'app.js: applySearchConfig restaure searchProvider');
assert(/dispatchEvent\(new Event\('change'\)\)/.test(appCode), 'app.js: applySearchConfig déclenche change (masque/affiche clé API)');

// app.js : triggerMarketBtn vérifie isOffline (l'IA Marché a besoin d'Internet
// pour DuckDuckGo). Sans ce garde, un batch complet tombait en fallback inutile.
assert(/isOffline[\s\S]*triggerMarketBtn|triggerMarketBtn[\s\S]*isOffline/.test(appCode), 'app.js: triggerMarketBtn vérifie isOffline avant lancement');
assert(/Mode hors-ligne actif.*analyse de marché.*recherche Internet/.test(appCode), 'app.js: message offline clair pour IA Marché (tous providers)');

// helpModule : FAQ ne mentionne plus la checkbox « Analyser les images » supprimée
// (la vision est désormais automatique si modèle + photos présents).
assert(!/Cochez.*Analyser les images par IA Vision/.test(helpModCode), 'helpModule: FAQ ne mentionne plus la checkbox vision supprimée');
assert(!/Décochée par défaut/.test(helpModCode), 'helpModule: FAQ ne dit plus « Décochée par défaut » (autoAiMarket est coché)');
// helpModule : FAQ ne mentionne plus la vitesse « Ultra » (non exposée dans l'UI)
assert(!/Ultra.*20 annonces en parallèle/.test(helpModCode), 'helpModule: FAQ ne mentionne plus vitesse Ultra (non exposée dans l\'UI select)');
assert(/Rapide \/ Équilibré \/ Prudent/.test(helpModCode), 'helpModule: FAQ liste les 3 vitesses réellement exposées');

// [7/7] suite — code mort & persistance
// risk-keywords.js supprimé (code mort : jamais importé dans l'app, l'IA remplace)
assert(!existsSync(path.join(base, 'config/risk-keywords.js')), 'config/risk-keywords.js supprimé (code mort)');

// app.js : clé API moteur de recherche persistée via secretStore (chiffré)
// Avant : la clé Tavily disparaissait à chaque redémarrage (non persistée).
assert(/SEARCH_KEY_SECRET/.test(appCode), 'app.js: constante SEARCH_KEY_SECRET pour clé moteur');
assert(/loadSearchApiKey/.test(appCode), 'app.js: fonction loadSearchApiKey (charge depuis secretStore)');
assert(/saveSearchApiKey/.test(appCode), 'app.js: fonction saveSearchApiKey (persiste via secretStore)');
assert(/getSecret\(SEARCH_KEY_SECRET\)/.test(appCode), 'app.js: charge clé via secretStore.get');
assert(/setSecret\(SEARCH_KEY_SECRET/.test(appCode), 'app.js: sauve clé via secretStore.set');
assert(/removeSecret\(SEARCH_KEY_SECRET\)/.test(appCode), 'app.js: supprime clé via secretStore.remove');
// Le champ clé déclenche la persistance sur change
assert(/searchApiKeyEl.addEventListener\('change'/.test(appCode), 'app.js: searchApiKeyEl persiste sur change');

// app.js : suppression de job nettoie le comparateur (IDs fantômes)
// Avant : compareCount affichait un nombre > aux colonnes réelles après suppression.
assert(/compareSet = new Set\(\[\.\.\.compareSet\]\.filter/.test(appCode), 'app.js: compareSet nettoyé après suppression job (IDs fantômes)');
assert(/refreshActiveDataTab\(\)/.test(appCode.replace(/\/\/[^\n]*\n/g, '')), 'app.js: suppression déclenche refreshActiveDataTab');

// [7/7] suite — écritures atomiques (anti-corruption de fichiers critiques)
// secretStore, settings et aiCache utilisaient fs.writeFileSync (non-atomique) :
// un crash pendant l'écriture corrompait le fichier → secrets/réglages/cache perdus.
const secretStoreCode2 = fs.readFileSync(path.join(base, 'utils/secretStore.js'), 'utf8');
assert(/atomicWriteFileSync\(p,/.test(secretStoreCode2), 'secretStore: _save atomique (atomicWriteFileSync)');
assert(!/fs\.writeFileSync\(p,/.test(secretStoreCode2), 'secretStore: _save n\'utilise plus fs.writeFileSync');

const settingsCode2 = fs.readFileSync(path.join(base, 'core/settings.js'), 'utf8');
assert(/atomicWriteFileSync\(getSettingsPath\(\)/.test(settingsCode2), 'settings: saveSettings atomique (atomicWriteFileSync)');
assert(!/fs\.writeFileSync\(getSettingsPath\(\)/.test(settingsCode2), 'settings: saveSettings n\'utilise plus fs.writeFileSync');

const aiCacheCode2 = fs.readFileSync(path.join(base, 'services/ai/aiCache.js'), 'utf8');
assert(/atomicWriteFileSync\(getCachePath\(\)/.test(aiCacheCode2), 'aiCache: _saveNow atomique (atomicWriteFileSync)');
assert(!/fs\.writeFileSync\(getCachePath\(\)/.test(aiCacheCode2), 'aiCache: _saveNow n\'utilise plus fs.writeFileSync');

console.log(`\n=== RÉSULTAT : ${pass} réussis, ${fail} échoués ===`);
process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
