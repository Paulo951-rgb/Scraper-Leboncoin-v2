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
const { MarketAnalyzer } = require('../src/main/modules/marketAnalyzer');
const { GlobalAnalyzer } = require('../src/main/modules/globalAnalyzer');
const { JobSchedulerManager } = require('../src/main/modules/jobScheduler');
const { DealFinder } = require('../src/main/modules/dealFinder');
const { StorageCleaner } = require('../src/main/modules/storageCleaner');
const { FileManager } = require('../src/main/modules/fileManager');

assert(typeof MarketAnalyzer.analyzeAds === 'function', 'MarketAnalyzer.analyzeAds');
assert(typeof GlobalAnalyzer.analyze === 'function', 'GlobalAnalyzer.analyze');
assert(typeof JobSchedulerManager === 'function', 'JobSchedulerManager constructor');
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

// Scheduler propagation du proxyUrl + isScheduled
const sched = new JobSchedulerManager(() => {});
sched.addSchedule({ id: 't1', searchUrl: 'https://lbc.fr', pages: 2, intervalMinutes: 30, proxyUrl: 'http://p:8080', limit: 5, aiConfig: { provider: 'openai' } });
assert(sched.scheduledTasks.size === 1, 'scheduler addSchedule');
const stored = Array.from(sched.scheduledTasks.values())[0];
const payload = sched._triggerPayload(stored);
assert(payload.proxyUrl === 'http://p:8080', 'scheduler propagates proxyUrl in trigger payload');
assert(payload.isScheduled === true, 'scheduler payload marked isScheduled');
sched.removeSchedule('t1');
assert(sched.scheduledTasks.size === 0, 'scheduler removeSchedule');

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
  const child = fork(path.join(__dirname, '..', 'src/main/vendor/leboncoin-pipeline.js'), [harPath, '--out', tmpOut, '--headless', '--no-desc', '--csv'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
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
const ipcCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/ipcHandlers.js'), 'utf8');
const maCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/modules/marketAnalyzer.js'), 'utf8');

assert(/(let|const)\s+mapInstance\b/.test(appCode), 'app.js: mapInstance declared');
assert(/(let|const)\s+dealsChartInstance\b/.test(appCode), 'app.js: dealsChartInstance declared');
assert(/function\s+loadSchedulerPage\b/.test(appCode), 'app.js: loadSchedulerPage defined');
assert(!/let\s+priceChartInstance\b/.test(appCode), 'app.js: priceChartInstance dead var removed');
assert(/if \(viewMode === 'table'\) viewGridBtn\.click\(\);\s*else viewTableBtn\.click\(\);/.test(appCode), 'app.js: Spacebar toggles table<->grid');
assert(/replace\(\/&\/g, '&amp;'\)/.test(appCode) && /replace\(\/"\/g, '&quot;'\)/.test(appCode), 'app.js: escapeHtml escapes & " < >');
assert(/window\.api\.openExternal\(urlStr\)/.test(appCode), 'app.js: openUrl uses openExternal');
assert(/openFolder\(''\)/.test(appCode) && !/openFolder\('output'\)/.test(appCode), 'app.js: output button passes empty string');
assert(/return !a\.shipping;/.test(appCode), 'app.js: main-propre filter uses boolean shipping');
assert(/MAX_LOG_LINES\s*=\s*1000/.test(appCode), 'app.js: log line cap (1000)');
assert(/onSchedulerTrigger/.test(appCode), 'app.js: onSchedulerTrigger subscribed');
assert(/window\.removeSchedule\s*=/.test(appCode), 'app.js: removeSchedule exposed');
assert(/openExternal:\s*\(urlStr\)\s*=>\s*ipcRenderer\.invoke\('shell:openExternal'/.test(preloadCode), 'preload.js: openExternal exposed');
assert(/folderPath \|\| BASE_OUT_DIR/.test(ipcCode), 'ipcHandlers.js: openFolder defaults to BASE_OUT_DIR');
assert(/shell:openExternal/.test(ipcCode), 'ipcHandlers.js: shell:openExternal handler present');
assert(/provider === 'openai' && !apiKey/.test(maCode), 'marketAnalyzer.js: handles openai without apiKey');

// MarketAnalyzer fallback avec OpenAI sans clé
const result = await MarketAnalyzer.analyzeAds([{ id: '1', title: 'Test', price: 100 }], { provider: 'openai' });
assert(result.length === 1 && result[0].marketAnalysis.confidence === 'Faible', 'marketAnalyzer openai-no-key → fallback Faible');

console.log(`\n=== RÉSULTAT : ${pass} réussis, ${fail} échoués ===`);
process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
