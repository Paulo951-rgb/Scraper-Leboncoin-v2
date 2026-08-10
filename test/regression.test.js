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
const { MarketAnalyzer } = require('../src/main/services/ai/marketAnalyzer');
const { DealFinder } = require('../src/main/services/analysis/dealFinder');
const { StorageCleaner } = require('../src/main/services/maintenance/storageCleaner');
const { FileManager } = require('../src/main/infrastructure/fileManager');
const { Notifier } = require('../src/main/infrastructure/notifications');
const { loadSettings, saveSettings } = require('../src/main/core/settings');
const { RISK_KEYWORDS } = require('../src/main/config/risk-keywords');

assert(typeof MarketAnalyzer.analyzeAds === 'function', 'MarketAnalyzer.analyzeAds');
assert(typeof DealFinder.analyze === 'function', 'DealFinder.analyze');
assert(typeof StorageCleaner.cleanOldHars === 'function', 'StorageCleaner.cleanOldHars');
assert(typeof FileManager.openFile === 'function', 'FileManager.openFile');
assert(typeof FileManager.openFolder === 'function', 'FileManager.openFolder');

// DealFinder
const ads = [
  { id: '1', title: 'iPhone 12', price: 100 },
  { id: '2', title: 'Samsung S21', price: 300 },
  { id: '3', title: 'Pixel 6', price: 200 },
];
const { stats, enrichedAds } = DealFinder.analyze(ads);
assert(stats && stats.totalAds === 3, 'DealFinder stats.totalAds');
assert(enrichedAds.length === 3, 'DealFinder enrichedAds length');
assert(enrichedAds[0].hasOwnProperty('dealTag'), 'DealFinder adds dealTag');

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
  owner: { name: 'Vendeur', type: 'particulier' },
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
  const child = fork(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), [harPath, '--out', tmpOut, '--headless', '--no-desc', '--csv'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
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
    fs.rmSync(tmpOut, { recursive: true, force: true });
    resolve();
  });
});

// --- 4. Corrections PR #3 (renderer + main) ---
console.log('\n[4/4] Corrections PR #3');
const appCode = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.js'), 'utf8');
const preloadCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/preload.js'), 'utf8');
const ipcCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/core/ipcHandlers.js'), 'utf8');
const maCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/ai/marketAnalyzer.js'), 'utf8');

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
assert(/provider === 'openai' && !apiKey/.test(maCode), 'marketAnalyzer.js: handles openai without apiKey');

// MarketAnalyzer fallback avec OpenAI sans clé
const result = await MarketAnalyzer.analyzeAds([{ id: '1', title: 'Test', price: 100 }], { provider: 'openai' });
assert(result.length === 1 && result[0].marketAnalysis.confidence === 'Faible', 'marketAnalyzer openai-no-key → fallback Faible');

// --- 5. Nouvelle architecture (refactor structure) ---
console.log('\n[5/5] Architecture restructurée');
const { existsSync } = fs;
const base = path.join(__dirname, '..', 'src/main');

// Structure par couches
assert(existsSync(path.join(base, 'core/ipcHandlers.js')), 'core/ipcHandlers.js present');
assert(existsSync(path.join(base, 'core/settings.js')), 'core/settings.js (extrait) present');
assert(existsSync(path.join(base, 'config/constants.js')), 'config/constants.js present');
assert(existsSync(path.join(base, 'config/risk-keywords.js')), 'config/risk-keywords.js (extrait) present');
assert(existsSync(path.join(base, 'services/scraping/harCapturer.js')), 'services/scraping/harCapturer.js present');
assert(existsSync(path.join(base, 'services/scraping/pipelineRunner.js')), 'services/scraping/pipelineRunner.js present');
assert(existsSync(path.join(base, 'services/scraping/leboncoin-pipeline.js')), 'services/scraping/leboncoin-pipeline.js (déplacé du vendor/) present');
assert(existsSync(path.join(base, 'services/ai/marketAnalyzer.js')), 'services/ai/marketAnalyzer.js present');
assert(existsSync(path.join(base, 'services/analysis/dealFinder.js')), 'services/analysis/dealFinder.js present');
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

// risk-keywords extrait de constants
assert(Array.isArray(RISK_KEYWORDS) && RISK_KEYWORDS.length > 0, 'RISK_KEYWORDS in config/risk-keywords.js');
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
// Onglet scraper : option OpenAI retirée, autoAiMarket décoché par défaut
assert(!/value="openai"/.test(htmlCode), 'index.html: option OpenAI ChatGPT retirée du scraper');
assert(!/id="aiApiKey"/.test(htmlCode), 'index.html: champ clé API OpenAI retiré');
assert(/<input type="checkbox" id="autoAiMarket">/.test(htmlCode), 'index.html: autoAiMarket décoché par défaut');
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

// Générateur de prompt IA locale (Ollama, remplace les prompts statiques)
assert(existsSync(path.join(base, 'services/ai/promptGenerator.js')), 'services/ai/promptGenerator.js present');
const promptGenCode = fs.readFileSync(path.join(base, 'services/ai/promptGenerator.js'), 'utf8');
assert(/class PromptGenerator/.test(promptGenCode), 'promptGenerator: classe PromptGenerator');
assert(/_callOllama/.test(promptGenCode), 'promptGenerator: méthode _callOllama (appel local)');
assert(/\/api\/generate/.test(promptGenCode), 'promptGenerator: endpoint Ollama /api/generate');
assert(/AbortController/.test(promptGenCode), 'promptGenerator: AbortController (timeout fetch)');
assert(/stream:\s*false/.test(promptGenCode), 'promptGenerator: stream:false (réponse complète)');
assert(!/generativelanguage\.googleapis\.com/.test(promptGenCode), 'promptGenerator: aucun appel vers Gemini (IA locale uniquement)');
assert(!/require\('electron'\)/.test(promptGenCode), 'promptGenerator: pas de require(electron) (réutilisable hors app)');

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

console.log(`\n=== RÉSULTAT : ${pass} réussis, ${fail} échoués ===`);
process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
