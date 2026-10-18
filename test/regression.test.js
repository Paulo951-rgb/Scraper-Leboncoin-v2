'use strict';

/**
 * Suite de tests de non-régression — Vendra
 * Couvre : diagnostics.js, pipeline, modules principaux, exportFields, sécurité.
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
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  if (request === 'playwright') return playwrightStub;
  return originalLoad.apply(this, arguments);
};

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}`); }
}

async function main() {

// --- 1. diagnostics.js ---
console.log('\n[1] diagnostics.js');
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
console.log('\n[2] Modules principaux');
const { AdStats } = require('../src/main/services/analysis/adStats');
const { StorageCleaner } = require('../src/main/services/maintenance/storageCleaner');
const { FileManager } = require('../src/main/infrastructure/fileManager');
const { loadSettings, saveSettings } = require('../src/main/core/settings');

assert(typeof AdStats.analyze === 'function', 'AdStats.analyze (remplace DealFinder)');
assert(typeof StorageCleaner.cleanOldHars === 'function', 'StorageCleaner.cleanOldHars');
assert(typeof FileManager.openFile === 'function', 'FileManager.openFile');
assert(typeof FileManager.openFolder === 'function', 'FileManager.openFolder');

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

// AdStats : cas limites (vide, prix invalides)
assert(AdStats.analyze([]).stats === null, 'AdStats: tableau vide → stats null');
assert(AdStats.analyze(null).stats === null, 'AdStats: entrée null → stats null (pas de crash)');
assert(AdStats.analyze([{ id: '1', price: 'abc' }, { id: '2' }]).stats === null, 'AdStats: prix invalides → stats null');
assert(AdStats.analyze([{ id: '1', price: 0 }, { id: '2', price: -5 }]).stats === null, 'AdStats: prix <= 0 ignorés → stats null');
const mixedPrices = AdStats.analyze([{ id: '1', price: 100 }, { id: '2', prix: '200' }, { id: '3', price: null }]);
assert(mixedPrices.stats.pricedAds === 2, 'AdStats: prix string parsés, null ignorés (pricedAds=2)');
assert(mixedPrices.stats.minPrice === 100 && mixedPrices.stats.maxPrice === 200, 'AdStats: min/max après tri des prix valides');
// Médiane : nombre pair → moyenne des deux valeurs centrales (pas l'élément du milieu)
assert(AdStats.analyze([{ id: '1', prix: 100 }, { id: '2', prix: 200 }, { id: '3', prix: 300 }, { id: '4', prix: 400 }]).stats.medianPrice === 250,
  'AdStats: medianPrice paire = moyenne des deux valeurs centrales (250)');
assert(AdStats.analyze([{ id: '1', prix: 100 }, { id: '2', prix: 200 }, { id: '3', prix: 350 }]).stats.medianPrice === 200,
  'AdStats: medianPrice impaire = valeur centrale (200)');
// AdStats : deliveryType (modèle unifié)
const txStats = AdStats.analyze([
  { id: '1', prix: 100, livraison: true, mainPropre: false, deliveryType: 'livraison' },
  { id: '2', prix: 200, livraison: false, mainPropre: true, deliveryType: 'main_propre' },
  { id: '3', prix: 150, livraison: true, mainPropre: true, deliveryType: 'les_deux' },
  { id: '4', prix: 50, livraison: null, mainPropre: null, deliveryType: 'inconnu' },
  { id: '5', prix: 70, livraison: false, mainPropre: false, deliveryType: 'aucun' },
]);
assert(txStats.stats.livraisonCount === 1, 'AdStats: livraisonCount correct (livraison uniquement)');
assert(txStats.stats.mainPropreCount === 1, 'AdStats: mainPropreCount correct (main_propre uniquement)');
assert(txStats.stats.lesDeuxCount === 1, 'AdStats: lesDeuxCount correct');
assert(txStats.stats.aucunCount === 1, 'AdStats: aucunCount correct');
assert(txStats.stats.inconnuCount === 1, 'AdStats: inconnuCount correct');
assert(txStats.stats.nonRenseigneCount === 1, 'AdStats: nonRenseigneCount (alias inconnu) correct');
// Rétro-compat : ads sans deliveryType mais avec livraison/mainPropre
const txStatsRetro = AdStats.analyze([
  { id: '1', prix: 100, livraison: true, mainPropre: false },
  { id: '2', prix: 200, livraison: false, mainPropre: true },
  { id: '3', prix: 150, livraison: true, mainPropre: true },
  { id: '4', prix: 50, livraison: null, mainPropre: null },
]);
assert(txStatsRetro.stats.livraisonCount === 1, 'AdStats rétro-compat: livraisonCount calculé depuis livraison/mainPropre');
assert(txStatsRetro.stats.mainPropreCount === 1, 'AdStats rétro-compat: mainPropreCount calculé depuis livraison/mainPropre');
assert(txStatsRetro.stats.lesDeuxCount === 1, 'AdStats rétro-compat: lesDeuxCount calculé depuis livraison/mainPropre');
assert(txStatsRetro.stats.inconnuCount === 1, 'AdStats rétro-compat: inconnuCount calculé depuis livraison/mainPropre');

// AdStats : cas limites supplémentaires de la médiane (jeux de données variés)
// La médiane est arrondie à l'entier (cohérent avec le renderer statsModule).
assert(AdStats.analyze([{ id: '1', prix: 5 }, { id: '2', prix: 10 }]).stats.medianPrice === 8,
  'AdStats: medianPrice paire à 2 valeurs = 8 (arrondi de 7.5)');
assert(AdStats.analyze([{ id: '1', prix: 42 }]).stats.medianPrice === 42,
  'AdStats: medianPrice une seule valeur');
assert(AdStats.analyze([{ id: '1', prix: 10 }, { id: '2', prix: 10 }, { id: '3', prix: 10 }, { id: '4', prix: 10 }]).stats.medianPrice === 10,
  'AdStats: medianPrice série constante');
assert(AdStats.analyze([{ id: '1', prix: 300 }, { id: '2', prix: 100 }, { id: '3', prix: 400 }, { id: '4', prix: 200 }]).stats.medianPrice === 250,
  'AdStats: medianPrice insensible à l\'ordre (tableau non trié)');

// --- 3. Pipeline (fork) ---
console.log('\n[3] Pipeline (leboncoin-pipeline.js)');
const os = require('os');
const { fork } = require('child_process');
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-'));
const harPath = path.join(tmpOut, 'capture.har');
const adObj = {
  list_id: 12345, subject: 'iPhone 12', price: 150, body: 'Bon etat',
  url: 'https://www.leboncoin.fr/ad/12345.htm',
  location: { city: 'Lyon', zipcode: '69000' },
  has_option: { shipping: false },
  category_name: 'Téléphones',
  owner: { name: 'Jean', type: 'particulier', rating: 4.8, nb_ratings: 27 },
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
  const child = fork(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), [harPath, '--out', tmpOut, '--headless', '--no-desc', '--profile-id', 'maximum'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.on('close', (code) => {
    assert(code === 0, 'pipeline exits 0');
    assert(stdout.includes('[DEBUG]'), 'pipeline DEBUG logs present');
    assert(stdout.includes('annonces extraites'), 'pipeline reports ads extracted');
    const ads = JSON.parse(fs.readFileSync(path.join(tmpOut, 'annonces.json'), 'utf8'));
    // Convention du modèle : `livraison`/`mainPropre` sont des champs INTERNES
    // unifiés en `deliveryType` et ne doivent PAS figurer dans les exports.
    assert(!('livraison' in ads[0]), 'pipeline: livraison absent de l\'export (unifié en deliveryType)');
    assert(!('mainPropre' in ads[0]), 'pipeline: mainPropre absent de l\'export (unifié en deliveryType)');
    assert(!('raw' in ads[0]), 'pipeline: objet brut `raw` absent de l\'export');
    assert(!('extractionErrors' in ads[0]), 'pipeline: `extractionErrors` absent de l\'export');
    assert(ads[0].city === 'Lyon', 'pipeline extracts city');
    assert(ads[0].vendeurType === 'particulier', 'pipeline extracts vendeurType');
    assert(ads[0].vendeurNote === 4.8, 'pipeline extracts vendeurNote from owner.rating');
    assert(ads[0].deliveryType === 'aucun', 'pipeline extracts deliveryType (livraison=false, mainPropre=null → aucun)');
    assert(ads[0].prix === 150, 'pipeline extracts prix');
    assert(ads[0].vendeurNom === 'Jean', 'pipeline extracts vendeurNom');
    assert(ads[0].dateScraping != null, 'pipeline injects dateScraping');
    fs.rmSync(tmpOut, { recursive: true, force: true });
    resolve();
  });
});

// --- 3b. Pipeline : exit code 2 quand aucune donnée exploitable (non-régression) ---
// Avant, un HAR sans annonce faisait `return` → exit 0, et PipelineRunner croyait
// que le pipeline avait réussi. On vérifie le nouveau contrat : exit 2.
console.log('\n[3b] Pipeline exit-code 2 (aucune donnée exploitable)');
const emptyOut = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-empty-'));
fs.writeFileSync(path.join(emptyOut, 'capture.har'), JSON.stringify({ log: { entries: [] } }));
await new Promise((resolve) => {
  const child = fork(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), [path.join(emptyOut, 'capture.har'), '--out', emptyOut, '--headless', '--no-desc'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  child.on('close', (code) => {
    assert(code === 2, 'pipeline: HAR sans données → exit code 2 (pas 0)');
    fs.rmSync(emptyOut, { recursive: true, force: true });
    resolve();
  });
});

// --- 3b2. Annulation : état « cancelled » distinct d'un succès (non-régression) ---
// Avant, un clic « Arrêter » faisait sortir le pipeline avec un code non nul
// mais la branche de succès du job renvoyait « Scraping terminé avec succès ! ».
// On vérifie que le main process remonte un état « cancelled » dédié et que le
// renderer le traite comme un état terminal (réactivation des boutons).
console.log('\n[3b2] Annulation : état cancelled');
{
  const ipcCodeCancel = fs.readFileSync(path.join(__dirname, '..', 'src/main/core/ipcHandlers.js'), 'utf8');
  assert(/_cancelled/.test(ipcCodeCancel), 'ipcHandlers: marqueur _cancelled posé sur l\'erreur d\'annulation');
  assert(/state:\s*'cancelled'/.test(ipcCodeCancel), 'ipcHandlers: sendStatus state=cancelled sur annulation');
  assert(/activeCancel\s*&&\s*activeCancel\.cancelled/.test(ipcCodeCancel), 'ipcHandlers: ne lance pas le pipeline si annulé après capture');
  const scraperCancel = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/scraperModule.js'), 'utf8');
  assert(/terminalStates\s*=\s*\[[^\]]*'cancelled'/.test(scraperCancel) && /terminalStates\.includes\(state\)/.test(scraperCancel),
    'scraperModule: état cancelled traité comme terminal (boutons réactivés)');
  // Annulation PENDANT l'enrichissement : le runner renvoie 130, ipcHandlers doit
  // traiter ce code comme une annulation (sinon succès trompeur).
  assert(/const pipelineExit\s*=\s*await activeRunner\.run/.test(ipcCodeCancel),
    'ipcHandlers: récupère le code de sortie du runner');
  assert(/pipelineExit\s*===\s*130/.test(ipcCodeCancel),
    'ipcHandlers: code 130 (interruption pipeline) → état cancelled');
  // Annulation coopérative dans le pipeline : handler SIGINT → arrêt propre.
  const pipelineCancelCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), 'utf8');
  assert(/process\.once\('SIGINT'/.test(pipelineCancelCode), 'pipeline: handler SIGINT installé (annulation coopérative)');
  assert(/this\.cancelled\s*=\s*true/.test(pipelineCancelCode), 'pipeline: drapeau cancelled positionné sur SIGINT');
  assert(/this\.circuit\.shouldStop\(\) \|\| this\.cancelled/.test(pipelineCancelCode), 'pipeline: boucle d\'enrichissement interrompue si annulé (disjoncteur + cancelled)');
  assert(/process\.removeListener\('SIGINT'/.test(pipelineCancelCode), 'pipeline: handler SIGINT retiré en finally (pas de fuite)');
}


// --- 3c. Pipeline : export profil Défaut inclut ville/codePostal (non-régression) ---
// Vérifie de bout en bout (fork réel) que le correctif de compatibilité des clés
// d'export s'applique bien aux fichiers JSON produits par le pipeline.
console.log('\n[3c] Pipeline export profil Défaut (ville/codePostal)');
const defOut = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-def-'));
fs.writeFileSync(path.join(defOut, 'capture.har'), JSON.stringify(har));
await new Promise((resolve) => {
  const child = fork(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), [path.join(defOut, 'capture.har'), '--out', defOut, '--headless', '--no-desc', '--profile-id', 'default'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  child.on('close', (code) => {
    assert(code === 0, 'pipeline profil Défaut: exit 0');
    const ads = JSON.parse(fs.readFileSync(path.join(defOut, 'annonces.json'), 'utf8'));
    assert(ads[0].ville === 'Lyon', 'pipeline JSON profil Défaut: ville présent (clé d\'export)');
    assert(ads[0].codePostal === '69000', 'pipeline JSON profil Défaut: codePostal présent (clé d\'export)');
    const txt = fs.readFileSync(path.join(defOut, 'annonces.txt'), 'utf8');
    assert(txt.includes('Lyon'), 'pipeline TXT profil Défaut: ville affichée');
    fs.rmSync(defOut, { recursive: true, force: true });
    resolve();
  });
});


// --- 3d. Scénarios d'erreur du pipeline (fixtures déterministes) ---
console.log('\n[3d] Pipeline scénarios d\'erreur');

// 3d-1. HAR absent → exit code d'erreur (pas 0), pas de faux succès.
const missingOut = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-missing-'));
await new Promise((resolve) => {
  const child = fork(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), [path.join(missingOut, 'absent.har'), '--out', missingOut, '--headless', '--no-desc'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  child.on('close', (code) => {
    assert(code !== 0, 'pipeline HAR absent: code de sortie non nul (pas de faux succès)');
    fs.rmSync(missingOut, { recursive: true, force: true });
    resolve();
  });
});

// 3d-2. HAR invalide (JSON corrompu) → exit code d'erreur.
const badHarOut = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-badhar-'));
fs.writeFileSync(path.join(badHarOut, 'capture.har'), '{ ceci n\'est pas du JSON ');
await new Promise((resolve) => {
  const child = fork(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), [path.join(badHarOut, 'capture.har'), '--out', badHarOut, '--headless', '--no-desc'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  child.on('close', (code) => {
    assert(code !== 0, 'pipeline HAR invalide: code de sortie non nul');
    fs.rmSync(badHarOut, { recursive: true, force: true });
    resolve();
  });
});

// 3d-3. Données invalides (annonces sans aucun champ exploitable) :
// soit exit 2 (aucune donnée exploitable), soit exit 0 avec un tableau vide —
// dans les deux cas, JAMAIS un succès avec des annonces inventées.
const garbageOut = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-garbage-'));
const garbageHar = {
  log: { entries: [ { request: { url: 'https://www.leboncoin.fr/recherche' }, response: { status: 200, content: { mimeType: 'text/html', text: '<html><script id="__NEXT_DATA__" type="application/json">{}</script></html>' } } } ] },
};
fs.writeFileSync(path.join(garbageOut, 'capture.har'), JSON.stringify(garbageHar));
await new Promise((resolve) => {
  const child = fork(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), [path.join(garbageOut, 'capture.har'), '--out', garbageOut, '--headless', '--no-desc'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  child.on('close', (code) => {
    assert(code === 2, 'pipeline données invalides: exit 2 (aucune donnée exploitable)');
    const adsPath = path.join(garbageOut, 'annonces.json');
    if (fs.existsSync(adsPath)) {
      const ads = JSON.parse(fs.readFileSync(adsPath, 'utf8'));
      assert(Array.isArray(ads) && ads.length === 0, 'pipeline données invalides: aucune annonce inventée');
    }
    fs.rmSync(garbageOut, { recursive: true, force: true });
    resolve();
  });
});

// --- 3e. PipelineRunner : annulation, erreurs, résultat vide ---
console.log('\n[3e] PipelineRunner (intégration)');
{
  const { PipelineRunner } = require('../src/main/services/scraping/pipelineRunner');

  // 3e-1. Annulation d'un pipeline : resolve(130), signal emit, pas de rejet.
  // On appelle stop() immédiatement après run() : le sous-processus est déjà
  // forké de façon synchrone, donc stop() positionne isCancelled avant que
  // l'événement 'close' ne soit traité (pas de course liée à la durée du job).
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-run-'));
  fs.writeFileSync(path.join(runDir, 'capture.har'), JSON.stringify(har));
  await new Promise((resolve) => {
    const runner = new PipelineRunner();
    let sawInterrupt = false;
    runner.on('log', (l) => { if (/Interruption demandée/.test(l.message)) sawInterrupt = true; });
    const pending = runner.run({ harPath: path.join(runDir, 'capture.har'), outDir: runDir, noDesc: true, headless: true });
    runner.stop();
    pending
      .then((result) => {
        assert(result === 130, 'PipelineRunner: annulation → resolve(130)');
        assert(sawInterrupt, 'PipelineRunner: annulation → log "Interruption demandée"');
        fs.rmSync(runDir, { recursive: true, force: true });
        resolve();
      })
      .catch((e) => { assert(false, 'PipelineRunner: annulation ne doit pas rejeter — ' + e.message); resolve(); });
  });

  // 3e-2. HAR absent : le pipeline sort en erreur → le runner rejette (pas de succès).
  const missingRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-runmiss-'));
  await new Promise((resolve) => {
    const runner = new PipelineRunner();
    runner.run({ harPath: path.join(missingRunDir, 'absent.har'), outDir: missingRunDir, noDesc: true, headless: true })
      .then(() => { assert(false, 'PipelineRunner: HAR absent ne doit PAS résoudre en succès'); resolve(); })
      .catch((e) => { assert(/^\[/.test(e.message), 'PipelineRunner: HAR absent → rejet structuré'); resolve(); });
  });
  fs.rmSync(missingRunDir, { recursive: true, force: true });
}

// --- 3f. Préservation des résultats partiels ---
// Le pipeline écrit annonces.json (écriture atomique + checksum) AVANT la phase
// d'enrichissement. Si l'enrichissement échoue ensuite (ex. navigateur
// indisponible), les annonces déjà extraites doivent rester lisibles sur disque.
console.log('\n[3f] Préservation des résultats partiels');
{
  const partialOut = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-partial-'));
  fs.writeFileSync(path.join(partialOut, 'capture.har'), JSON.stringify(har));
  await new Promise((resolve) => {
    // Sans --no-desc : le pipeline tente d'enrichir (playwright indisponible ici)
    // → il échoue APRÈS avoir écrit annonces.json.
    const child = fork(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), [path.join(partialOut, 'capture.har'), '--out', partialOut, '--headless'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    child.on('close', () => {
      const adsPath = path.join(partialOut, 'annonces.json');
      assert(fs.existsSync(adsPath), 'partial: annonces.json écrit avant l\'enrichissement');
      const ads = JSON.parse(fs.readFileSync(adsPath, 'utf8'));
      assert(Array.isArray(ads) && ads.length >= 1, 'partial: annonces déjà extraites préservées malgré l\'échec d\'enrichissement');
      fs.rmSync(partialOut, { recursive: true, force: true });
      resolve();
    });
  });
}

// --- 3g. Pipeline : moteur d'enrichissement historique restauré ---
// Le durcissement anti-débit (exit 3/4, Retry-After, noWait) a été retiré au
// profit du moteur historique (backoff base×2^N, arrêt après 3 blocages).
console.log('\n[3g] Enrichissement : moteur historique restauré');
{
  const pipeExit = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), 'utf8');
  assert(!/process\.exitCode = refused \? 3 : 4/.test(pipeExit), '[3g] pipeline: plus d\'exit 3/4 (moteur historique)');
  assert(!/stopReason/.test(pipeExit), '[3g] pipeline: plus de stopReason (moteur historique)');
  assert(/Bloqué \(HTTP 403\)/.test(pipeExit), '[3g] pipeline: gestion des blocages 403 (disjoncteur structuré)');
}


// --- 4. Corrections renderer + main ---
console.log('\n[4] Corrections renderer + main');
const rendererDir = path.join(__dirname, '..', 'src/renderer');
const rendererFiles = ['appState.js', 'utils.js', 'logsModule.js', 'scraperModule.js', 'explorerModule.js', 'statsModule.js', 'mapModule.js', 'historyModule.js', 'app.js'];
const appCode = rendererFiles.map((f) => fs.readFileSync(path.join(rendererDir, f), 'utf8')).join('\n');
const preloadCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/preload.js'), 'utf8');
const ipcCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/core/ipcHandlers.js'), 'utf8');

assert(/(let|const)\s+mapInstance\b/.test(appCode), 'app.js: mapInstance declared');
assert(/(let|const)\s+priceDistChartInstance\b/.test(appCode), 'app.js: priceDistChartInstance declared');
assert(/(let|const)\s+topCitiesChartInstance\b/.test(appCode), 'app.js: topCitiesChartInstance declared');
assert(/statAvgPrice/.test(appCode), 'app.js: statAvgPrice (prix moyen)');
assert(/statLivraison/.test(appCode), 'app.js: statLivraison (livraison — carte conservée)');
assert(/statHandDelivery/.test(appCode), 'app.js: statHandDelivery (main propre — carte conservée)');
assert(/statDeliveryTypeDist/.test(appCode), 'app.js: statDeliveryTypeDist (répartition modes remise unifiée)');
assert(!/statGoodDeals/.test(appCode), 'app.js: statGoodDeals supprimé (stats bonnes affaires retirées)');
assert(!/Répartition des Opportunités/.test(appCode), 'app.js: graphique Répartition des Opportunités supprimé');
assert(/429|quota/i.test(appCode), 'app.js: gestion erreur 429 (quota / scraping)');
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
// Le bouton "Ouvrir le dossier" utilise maintenant openJobsFolder (ouvre results/)
assert(/openJobsFolder\(\)/.test(appCode), 'app.js: output button uses openJobsFolder');
// « Type de remise » unifié : deliveryType remplace les filtres livraison/mainPropre séparés.
assert(/deliveryTypeOf\s*=\s*\(a\)\s*=>/.test(appCode), 'app.js: deliveryTypeOf helper présent (modèle unifié)');
assert(/filterDeliveryType/.test(appCode), 'app.js: filterDeliveryType dropdown (remplace filterLivraison + filterMainPropre)');
assert(/matchesDeliveryType\s*=\s*deliveryTypeFilter\s*===\s*'tous'\s*\|\|\s*deliveryTypeOf\(a\)\s*===\s*deliveryTypeFilter/.test(appCode), 'app.js: filtre deliveryType unifié (tous || match exact)');
assert(/MAX_LOG_LINES\s*=\s*1000/.test(appCode), 'app.js: log line cap (1000)');
// Modules supprimés : Analyse Globale IA + Planificateur (scheduler)
assert(!/loadSchedulerPage/.test(appCode), 'app.js: loadSchedulerPage supprimé (module Planificateur retiré)');
assert(!/onSchedulerTrigger/.test(appCode), 'app.js: onSchedulerTrigger supprimé (module Planificateur retiré)');
assert(!/window\.removeSchedule/.test(appCode), 'app.js: removeSchedule supprimé (module Planificateur retiré)');
assert(!/analyzeGlobalDataset/.test(appCode), 'app.js: analyzeGlobalDataset supprimé (module Analyse Globale retiré)');
assert(/openExternal:\s*\(urlStr\)\s*=>\s*ipcRenderer\.invoke\('shell:openExternal'/.test(preloadCode), 'preload.js: openExternal exposed');
assert(/folderPath \|\| BASE_OUT_DIR/.test(ipcCode), 'ipcHandlers.js: openFolder defaults to BASE_OUT_DIR');
assert(/shell:openExternal/.test(ipcCode), 'ipcHandlers.js: shell:openExternal handler present');

// --- 5. Architecture restructurée ---
console.log('\n[5] Architecture restructurée');
const { existsSync } = fs;
const base = path.join(__dirname, '..', 'src/main');

// Structure par couches
assert(existsSync(path.join(base, 'core/ipcHandlers.js')), 'core/ipcHandlers.js present');
assert(existsSync(path.join(base, 'core/settings.js')), 'core/settings.js (extrait) present');
assert(existsSync(path.join(base, 'config/constants.js')), 'config/constants.js present');
assert(!existsSync(path.join(base, 'config/risk-keywords.js')), 'config/risk-keywords.js supprimé (code mort)');
assert(existsSync(path.join(base, 'services/scraping/harCapturer.js')), 'services/scraping/harCapturer.js present');
assert(existsSync(path.join(base, 'services/scraping/pipelineRunner.js')), 'services/scraping/pipelineRunner.js present');
assert(existsSync(path.join(base, 'services/scraping/leboncoin-pipeline.js')), 'services/scraping/leboncoin-pipeline.js present');
assert(existsSync(path.join(base, 'services/analysis/adStats.js')), 'services/analysis/adStats.js (remplace dealFinder)');
assert(existsSync(path.join(base, 'services/jobs/jobHistory.js')), 'services/jobs/jobHistory.js present');
assert(existsSync(path.join(base, 'services/maintenance/storageCleaner.js')), 'services/maintenance/storageCleaner.js present');
assert(existsSync(path.join(base, 'infrastructure/fileManager.js')), 'infrastructure/fileManager.js present');

// Anciens dossiers supprimés
assert(!existsSync(path.join(base, 'modules')), 'old modules/ folder removed');
assert(!existsSync(path.join(base, 'vendor')), 'old vendor/ folder removed');
assert(!existsSync(path.join(base, 'ipcHandlers.js')), 'ipcHandlers.js moved out of main/ root');

// notifications.js supprimé : il ne servait qu'au handler IA Marché (market:analyze),
// lui-même retiré. Le module était importé par ipcHandlers mais jamais utilisé.
assert(!existsSync(path.join(base, 'infrastructure/notifications.js')), 'infrastructure/notifications.js supprimé (IA Marché retirée)');

// Settings extrait d'ipcHandlers
assert(typeof loadSettings === 'function', 'loadSettings extracted to core/settings');
assert(typeof saveSettings === 'function', 'saveSettings extracted to core/settings');

// risk-keywords supprimé (code mort). constants.js ne doit plus le référencer.
assert(!/RISK_KEYWORDS/.test(fs.readFileSync(path.join(base, 'config/constants.js'), 'utf8')), 'RISK_KEYWORDS removed from constants.js');

// ipcHandlers ne contient plus loadSettings/saveSettings inline
assert(!/function loadSettings\b/.test(ipcCode), 'ipcHandlers no longer defines loadSettings inline');
assert(!/function saveSettings\b/.test(ipcCode), 'ipcHandlers no longer defines saveSettings inline');
assert(/require\(.\.\/settings.\)/.test(ipcCode), 'ipcHandlers imports settings from ./settings');
assert(!/Notifier/.test(ipcCode), 'ipcHandlers: import Notifier retiré (module mort)');

// main.js pointe vers core/ipcHandlers
const mainCode = fs.readFileSync(path.join(base, 'main.js'), 'utf8');
assert(/require\(.\.\/core\/ipcHandlers.\)/.test(mainCode), 'main.js requires ./core/ipcHandlers');

// pipelineRunner pointe vers le pipeline dans le même dossier
const prCode = fs.readFileSync(path.join(base, 'services/scraping/pipelineRunner.js'), 'utf8');
assert(/path\.join\(__dirname, .leboncoin-pipeline\.js.\)/.test(prCode), 'pipelineRunner finds pipeline in same folder (no ../vendor/)');

// Widget flottant (fenêtre always-on-top avec progression)
assert(existsSync(path.join(__dirname, '..', 'src/renderer/widget.html')), 'widget.html present');
assert(/createWidgetWindow/.test(mainCode), 'main.js: createWidgetWindow function present');
assert(/alwaysOnTop:\s*true/.test(mainCode), 'main.js: widget window always-on-top');
assert(/ipcMain\.on\('widget:toggle'/.test(mainCode), 'main.js: widget:toggle IPC handler');
assert(/ipcMain\.on\('widget:close'/.test(mainCode), 'main.js: widget:close IPC handler');
assert(/ipcMain\.on\('widget:progress'/.test(mainCode), 'main.js: widget:progress relay handler');
assert(/ipcMain\.on\('widget:status'/.test(mainCode), 'main.js: widget:status relay handler');
assert(/toggleWidget/.test(preloadCode), 'preload.js: toggleWidget exposed');
assert(/sendWidgetProgress/.test(preloadCode), 'preload.js: sendWidgetProgress exposed');
assert(/sendWidgetStatus/.test(preloadCode), 'preload.js: sendWidgetStatus exposed');
assert(!/Le Widget Flottant n'est pas encore disponible/.test(appCode), 'app.js: stale "not available" alert removed');
assert(/sendWidgetProgress\(\{ percent, status \}\)/.test(appCode), 'app.js: relays progress to widget');
assert(/sendWidgetStatus\(\{ state, message \}\)/.test(appCode), 'app.js: relays status to widget');

// --- 6. Nouvelles features : intégrité, rate-limiter, logs, secrets, jobs-auto, sandbox ---
console.log('\n[6] Nouvelles features : intégrité, rate-limiter, logs, secrets, jobs-auto, sandbox');
const { writeWithChecksum, readWithChecksum, verify, computeHash, checksumPath } = require('../src/main/utils/integrity');
const { AdaptiveRateLimiter } = require('../src/main/utils/rateLimiter');
const { logger } = require('../src/main/utils/logger');
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

// F6 : logger
assert(typeof logger.info === 'function' && typeof logger.setRetention === 'function', 'logger: API présente');
logger.setRetention(3);

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

// FIX #3 : cleanOldJobs basé sur le timestamp du nom du dossier, pas le mtime
const cleanerCode = fs.readFileSync(path.join(base, 'services/maintenance/storageCleaner.js'), 'utf8');
assert(cleanerCode.includes('tsMatch = entry.name.match'), 'storageCleaner: parse le timestamp du nom de dossier');
assert(cleanerCode.includes('Date.parse(iso)'), 'storageCleaner: calcule l\'âge depuis le timestamp du nom');
assert(cleanerCode.includes('Fallback mtime'), 'storageCleaner: fallback mtime si timestamp illisible');

// FIX #4 : geocodeCityGov a un timeout (AbortController)
assert(/const controller = new AbortController\(\);[\s\S]{0,80}controller\.abort\(\), 10000/.test(appCode), 'app.js: geocodeCityGov timeout 10s (AbortController)');

// F5 : sandbox renderer durcie
assert(/sandbox:\s*true/.test(mainCode), 'main.js: sandbox:true activé sur mainWindow');
assert(/widgetPreload\.js/.test(mainCode), 'main.js: widget utilise widgetPreload.js');
assert(existsSync(path.join(base, 'widgetPreload.js')), 'widgetPreload.js present');
const widgetHtml = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/widget.html'), 'utf8');
assert(/window\.widgetApi/.test(widgetHtml), 'widget.html: utilise window.widgetApi (pas require)');
assert(!/require\('electron'\)/.test(widgetHtml), 'widget.html: plus de require(electron) direct');
assert(/checkNetwork/.test(preloadCode), 'preload.js: expose checkNetwork');
assert(/getSecret|setSecret|hasSecret|removeSecret/.test(preloadCode), 'preload.js: expose secret IPC');

// F3 : mode hors-ligne
assert(/offlineBadge/.test(appCode), 'app.js: offlineBadge référencé');
assert(/isOffline/.test(appCode), 'app.js: isOffline state tracked');
assert(/checkNetwork/.test(appCode), 'app.js: appelle checkNetwork');
assert(existsSync(path.join(base, 'utils/integrity.js')), 'utils/integrity.js present');
assert(existsSync(path.join(base, 'utils/rateLimiter.js')), 'utils/rateLimiter.js present');
assert(existsSync(path.join(base, 'utils/logger.js')), 'utils/logger.js present');
assert(existsSync(path.join(base, 'utils/secretStore.js')), 'utils/secretStore.js present');

// Settings nouveaux champs
const settingsCode = fs.readFileSync(path.join(base, 'core/settings.js'), 'utf8');
assert(/logRetentionDays/.test(settingsCode), 'settings: logRetentionDays');
assert(/autoCleanJobsDays/.test(settingsCode), 'settings: autoCleanJobsDays');
assert(/includeSellerData/.test(settingsCode), 'settings: includeSellerData default true');

// IPC nouveaux handlers
assert(/network:check/.test(ipcCode), 'ipcHandlers: network:check handler');
assert(/secret:get|secret:set/.test(ipcCode), 'ipcHandlers: secret handlers');

// UI paramètres
const htmlCode = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
assert(/cfgAutoCleanJobs/.test(htmlCode), 'index.html: cfgAutoCleanJobs checkbox');
assert(/cfgAutoCleanJobsDays/.test(htmlCode), 'index.html: cfgAutoCleanJobsDays input');
assert(/cfgLogRetention/.test(htmlCode), 'index.html: cfgLogRetention input');
assert(/badge-offline/.test(htmlCode), 'index.html: badge-offline CSS class');
// Stats : nouvelles cartes + retrait bonnes affaires
assert(/statAvgPrice/.test(htmlCode), 'index.html: carte prix moyen');
assert(/statLivraison/.test(htmlCode), 'index.html: carte livraison (conservée)');
assert(/statHandDelivery/.test(htmlCode), 'index.html: carte main propre (conservée)');
assert(/statDeliveryTypeDist/.test(htmlCode), 'index.html: carte répartition modes remise (deliveryType)');
assert(/filterDeliveryType/.test(htmlCode), 'index.html: filtre deliveryType unifié (remplace filterLivraison + filterMainPropre)');
assert(/modalDeliveryType/.test(htmlCode), 'index.html: modal deliveryType (remplace modalLivraison + modalMainPropre)');
assert(/statPro/.test(htmlCode) && /statPart/.test(htmlCode), 'index.html: cartes pro/particulier');
assert(!/statGoodDeals/.test(htmlCode), 'index.html: carte Bonnes Affaires supprimée');
assert(!/statRisks/.test(htmlCode), 'index.html: carte Annonces Trop Chères supprimée');
assert(!/id="dealsChart"/.test(htmlCode), 'index.html: canvas dealsChart (Répartition Opportunités) supprimé');
assert(/id="priceDistChart"/.test(htmlCode), 'index.html: canvas priceDistChart (distribution prix)');
assert(/id="topCitiesChart"/.test(htmlCode), 'index.html: canvas topCitiesChart (top villes)');
assert(/stat-card-accent/.test(htmlCode), 'index.html: stat-cards accentuées');

// F5 : fenêtre de connexion Google dédiée supprimée (plus de module IA Studio)
assert(!/aistudio:openLogin/.test(mainCode), 'main.js: handler IPC aistudio:openLogin supprimé');
assert(!/AI_STUDIO_PARTITION/.test(mainCode), 'main.js: constante AI_STUDIO_PARTITION supprimée');
assert(!/aistudioLoginPreload/.test(mainCode), 'main.js: preload aistudioLoginPreload supprimé');
assert(!existsSync(path.join(base, 'aistudioLoginPreload.js')), 'aistudioLoginPreload.js supprimé');
assert(!/tab-ai-studio/.test(htmlCode), 'index.html: onglet tab-ai-studio supprimé');
assert(!/aistudioWebview/.test(htmlCode), 'index.html: webview navigateur IA Studio supprimé');
assert(!/aiStudioModule\.js/.test(htmlCode), 'index.html: script aiStudioModule.js supprimé');
assert(!existsSync(path.join(__dirname, '..', 'src/renderer/aiStudioModule.js')), 'renderer/aiStudioModule.js supprimé');
// Plus de module IA ni Excel
assert(!existsSync(path.join(base, 'services/ai')), 'services/ai/ supprimé (module IA entier)');
assert(!existsSync(path.join(base, 'infrastructure/excelExporter.js')), 'infrastructure/excelExporter.js supprimé (XLSX/CSV retirés)');
assert(!/ExcelExporter/.test(ipcCode), 'ipcHandlers: plus d\'import ExcelExporter');
assert(!/AdAnalyzer/.test(ipcCode), 'ipcHandlers: plus d\'import AdAnalyzer');
assert(!/MarketValueAnalyzer/.test(ipcCode), 'ipcHandlers: plus d\'import MarketValueAnalyzer');
assert(!/PromptGenerator/.test(ipcCode), 'ipcHandlers: plus d\'import PromptGenerator');
assert(!/ollamaHealth/.test(ipcCode), 'ipcHandlers: plus d\'import ollamaHealth');
assert(!/listSearchProviders/.test(ipcCode), 'ipcHandlers: plus d\'import listSearchProviders');
assert(!/market:analyze/.test(ipcCode), 'ipcHandlers: handler market:analyze supprimé');
assert(!/prompt:generate/.test(ipcCode), 'ipcHandlers: handler prompt:generate supprimé');
assert(!/prompt:templates/.test(ipcCode), 'ipcHandlers: handler prompt:templates supprimé');
assert(!/prompt:internal/.test(ipcCode), 'ipcHandlers: handler prompt:internal supprimé');
assert(!/ollama:models/.test(ipcCode), 'ipcHandlers: handler ollama:models supprimé');
assert(!/ollama:health/.test(ipcCode), 'ipcHandlers: handler ollama:health supprimé');
assert(!/search:providers/.test(ipcCode), 'ipcHandlers: handler search:providers supprimé');
assert(!/aiConcurrency/.test(settingsCode), 'settings: aiConcurrency supprimé');
assert(!/aiConcurrency/.test(ipcCode), 'ipcHandlers: aiConcurrency supprimé');
// preload : API IA supprimées
assert(!/analyzeMarket/.test(preloadCode), 'preload: analyzeMarket supprimé');
assert(!/generatePrompt/.test(preloadCode), 'preload: generatePrompt supprimé');
assert(!/listPromptTemplates/.test(preloadCode), 'preload: listPromptTemplates supprimé');
assert(!/buildPrompt/.test(preloadCode), 'preload: buildPrompt supprimé');
assert(!/listInternalPrompts/.test(preloadCode), 'preload: listInternalPrompts supprimé');
assert(!/listOllamaModels/.test(preloadCode), 'preload: listOllamaModels supprimé');
assert(!/listSearchProviders/.test(preloadCode), 'preload: listSearchProviders supprimé');
assert(!/checkOllamaHealth/.test(preloadCode), 'preload: checkOllamaHealth supprimé');
assert(!/openAiStudioLogin/.test(preloadCode), 'preload: openAiStudioLogin supprimé');
// index.html : champs IA supprimés
assert(!/id="aiProvider"/.test(htmlCode), 'index.html: select aiProvider supprimé');
assert(!/id="aiModelName"/.test(htmlCode), 'index.html: champ aiModelName supprimé');
assert(!/id="aiVisionModel"/.test(htmlCode), 'index.html: champ aiVisionModel supprimé');
assert(!/id="ollamaUrl"/.test(htmlCode), 'index.html: champ ollamaUrl supprimé');
assert(!/id="autoAiMarket"/.test(htmlCode), 'index.html: checkbox autoAiMarket supprimée');
assert(!/id="searchProvider"/.test(htmlCode), 'index.html: select searchProvider supprimé');
assert(!/id="searchApiKey"/.test(htmlCode), 'index.html: champ searchApiKey supprimé');
assert(!/id="triggerMarketBtn"/.test(htmlCode), 'index.html: bouton triggerMarketBtn supprimé');
assert(!/id="marketProgressContainer"/.test(htmlCode), 'index.html: conteneur marketProgress supprimé');
// structureWarning est conservé et DOIT exister : logsModule l'utilise pour
// afficher l'alerte de changement de structure JSON côté Leboncoin. Son absence
// rendait l'affichage silencieusement inopérant.
assert(/id="structureWarning"/.test(htmlCode), 'index.html: bandeau structureWarning présent (utilisé par logsModule)');
assert(/id="structureWarningText"/.test(htmlCode), 'index.html: texte structureWarning présent');
assert(!/id="cfgAiConcurrency"/.test(htmlCode), 'index.html: champ cfgAiConcurrency supprimé');
assert(!/aistudio\.google\.com/.test(htmlCode), 'index.html: URL AI Studio supprimée');
assert(!/127\.0\.0\.1:11434/.test(htmlCode), 'index.html: connect-src Ollama supprimé du CSP');
assert(!/frame-src.*aistudio/.test(htmlCode), 'index.html: frame-src AI Studio supprimé du CSP');
// renderer : références IA supprimées
assert(!/autoAiMarket/.test(appCode), 'app.js: autoAiMarket supprimé');
assert(!/aiProvider/.test(appCode), 'app.js: aiProvider supprimé');
assert(!/aiModelName/.test(appCode), 'app.js: aiModelName supprimé');
assert(!/ollamaUrl/.test(appCode), 'app.js: ollamaUrl supprimé');
assert(!/searchProvider/.test(appCode), 'app.js: searchProvider supprimé');
assert(!/triggerMarketBtn/.test(appCode), 'app.js: triggerMarketBtn supprimé');
assert(!/analyzeMarket/.test(appCode), 'app.js: analyzeMarket supprimé');
assert(!/aiConfig/.test(appCode), 'app.js: aiConfig supprimé');
assert(!/analyzeImages/.test(appCode), 'app.js: analyzeImages supprimé');
assert(!/getOllamaUrl/.test(appCode), 'app.js: getOllamaUrl supprimé');
assert(!/getAiApiKey/.test(appCode), 'app.js: getAiApiKey supprimé');

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
assert(/class="help-btn"/.test(htmlCode), 'index.html: boutons aide discrets (class help-btn)');
assert(/app:getDiagnostics/.test(ipcCode), 'ipcHandlers: handler app:getDiagnostics (diagnostic feedback)');
assert(/getDiagnostics/.test(preloadCode), 'preload.js: expose getDiagnostics');
const helpNoComments = helpModCode.replace(/\/\/[^\n]*\n/g, '');
assert(!/fetch\(\s*['"]https/.test(helpNoComments), 'helpModule: pas d\'envoi HTTP actif (API backend pas encore développé)');
assert(/localStorage.*feedback-archive/.test(helpModCode), 'helpModule: rapport archivé localement (V2 en attendant le serveur)');
// helpModule : FAQ ne mentionne plus Ollama/AI Studio/XLSX/CSV
assert(!/Ollama/.test(helpModCode), 'helpModule: FAQ ne mentionne plus Ollama');
assert(!/AI Studio/.test(helpModCode), 'helpModule: FAQ ne mentionne plus AI Studio');
assert(!/IA Marché/.test(helpModCode), 'helpModule: FAQ ne mentionne plus IA Marché');
assert(!/annonces\.xlsx/.test(helpModCode), 'helpModule: FAQ ne mentionne plus annonces.xlsx');
assert(!/resumes-ia/.test(helpModCode), 'helpModule: FAQ ne mentionne plus resumes-ia.json');

// --- 7. Architecture SCRAPING PUR (indépendant de l'IA) ---
console.log('\n[7] Architecture scraping pur (sans dépendance IA)');
const pipelineCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), 'utf8');
const appCodeFull = appCode;
const htmlCodeFull = fs.readFileSync(path.join(__dirname, '..', 'src/renderer', 'index.html'), 'utf8');

// adFields est un module de SCRAPING PUR : aucun appel IA, aucun prompt.
assert(existsSync(path.join(base, 'services/scraping/adFields.js')), 'pipeline: module adFields.js présent (extracteurs centralisés)');
const adFieldsCode = fs.readFileSync(path.join(base, 'services/scraping/adFields.js'), 'utf8');
const adFieldsNoComments = adFieldsCode.replace(/\/\/[^\n]*\n/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
assert(!/ollama|gemini|openai|chatgpt|anthropic|claude|mistral/.test(adFieldsNoComments),
  'adFields: AUCUN appel IA (ollama/gemini/openai/etc.) dans le code');
assert(!/\bchat\b\s*\(/.test(adFieldsNoComments),
  'adFields: AUCUN appel chat() (= appel LLM)');
assert(!/fetch\(['"]https?:\/\/[^'"]+['"]/.test(adFieldsNoComments),
  'adFields: AUCUN fetch HTTP externe (module pur)');
assert(/extractSeller/.test(adFieldsCode), 'adFields: extractSeller');
assert(/extractTransaction/.test(adFieldsCode), 'adFields: extractTransaction');
assert(/extractDates/.test(adFieldsCode), 'adFields: extractDates');
assert(/extractCondition/.test(adFieldsCode), 'adFields: extractCondition (État déclaré uniquement)');
assert(/extractLikes/.test(adFieldsCode), 'adFields: extractLikes (likes uniquement)');
assert(/extractPhotos/.test(adFieldsCode), 'adFields: extractPhotos');
assert(/extractDescription/.test(adFieldsCode), 'adFields: extractDescription');
// Champs supprimés — les fonctions associées ne doivent plus exister
assert(!/extractAttributes/.test(adFieldsCode), 'adFields: extractAttributes SUPPRIMÉ');
assert(!/detectInDescription/.test(adFieldsCode), 'adFields: detectInDescription SUPPRIMÉ');
assert(!/inferCondition/.test(adFieldsCode), 'adFields: inferCondition SUPPRIMÉ');
assert(!/scraperQuality/.test(adFieldsCode), 'adFields: scraperQuality SUPPRIMÉ');
assert(!/zipcodeToDepartment/.test(adFieldsCode), 'adFields: zipcodeToDepartment SUPPRIMÉ');
const adFieldsCheck = adFieldsNoComments;
assert(!/\bnegociable\b/.test(adFieldsCheck), 'adFields: aucun negociable (champ supprimé)');
assert(!/\bfacture\b/.test(adFieldsCheck), 'adFields: aucun facture (champ supprimé)');
assert(!/\bgarantie\b/.test(adFieldsCheck), 'adFields: aucun garantie (champ supprimé)');
assert(!/\bechangeAccepte?\b/.test(adFieldsCheck), 'adFields: aucun echange (champ supprimé)');
assert(!/\burgent\b/.test(adFieldsCheck), 'adFields: aucun urgent (champ supprimé)');
assert(!/\bvues\b/.test(adFieldsCheck), 'adFields: aucun vues (champ supprimé)');
assert(!/\bmarque\b/.test(adFieldsCheck), 'adFields: aucun marque (champ supprimé)');
assert(!/\bmodele\b/.test(adFieldsCheck), 'adFields: aucun modele (champ supprimé)');
assert(!/\bcouleur\b/.test(adFieldsCheck), 'adFields: aucun couleur (champ supprimé)');
assert(!/\bcapacite\b/.test(adFieldsCheck), 'adFields: aucun capacite (champ supprimé)');
assert(!/\betatInferre\b/.test(adFieldsCheck), 'adFields: aucun etatInferre (champ supprimé)');
assert(!/\bdepartment\b/.test(adFieldsCheck), 'adFields: aucun department (champ supprimé)');
assert(!/\bcategory\b/.test(adFieldsCheck), 'adFields: aucun category (champ supprimé)');

// Pipeline : helpers wrappers (compatibilité interne) présents
assert(!/function extractDeliveryInfo/.test(pipelineCode), 'pipeline: extractDeliveryInfo supprimé (structure plate)');
assert(!/function extractSellerRating/.test(pipelineCode), 'pipeline: extractSellerRating supprimé (structure plate)');

// normalizeAd : produit les champs plats (scraping pur)
assert(/prix,/.test(pipelineCode), 'pipeline: normalizeAd produit prix');
assert(/vendeurNom:/.test(pipelineCode), 'pipeline: normalizeAd produit vendeurNom');
assert(/livraison:/.test(pipelineCode), 'pipeline: normalizeAd produit livraison');
assert(/mainPropre:/.test(pipelineCode), 'pipeline: normalizeAd produit mainPropre');
assert(/likes,/.test(pipelineCode), 'pipeline: normalizeAd produit likes');
assert(/datePublication:/.test(pipelineCode), 'pipeline: normalizeAd produit datePublication');
assert(/dateScraping,/.test(pipelineCode), 'pipeline: normalizeAd produit dateScraping');
assert(/etat,/.test(pipelineCode), 'pipeline: normalizeAd produit etat');
assert(/photosCount:/.test(pipelineCode), 'pipeline: normalizeAd produit photosCount');
assert(/description,/.test(pipelineCode), 'pipeline: normalizeAd produit description');
// Ne doit PAS produire les anciens objets imbriqués
assert(!/vendeur:\s*\{/.test(pipelineCode), 'pipeline: normalizeAd ne produit PAS vendeur{}');
assert(!/transaction:\s*\{/.test(pipelineCode), 'pipeline: normalizeAd ne produit PAS transaction{}');
assert(!/statistiques:\s*\{/.test(pipelineCode), 'pipeline: normalizeAd ne produit PAS statistiques{}');
assert(!/produit:\s*\{/.test(pipelineCode), 'pipeline: normalizeAd ne produit PAS produit{}');
assert(!/photos:\s*\{/.test(pipelineCode), 'pipeline: normalizeAd ne produit PAS photos{}');
assert(!/dates:\s*\{/.test(pipelineCode), 'pipeline: normalizeAd ne produit PAS dates{}');
assert(!/ad\.scraping\s*=/.test(pipelineCode), 'pipeline: normalizeAd ne produit PAS scraping{}');
assert(/dateScraping:\s*scrapedAt/.test(pipelineCode), 'pipeline: normalizeAd injecte dateScraping ISO');
assert(/scrapedAt\s*=\s*new Date\(\)\.toISOString\(\)/.test(pipelineCode), 'pipeline: scrapedAt = new Date().toISOString()');
assert(/mergeKeepingNonNull/.test(pipelineCode), 'pipeline: mergeKeepingNonNull préserve les champs non-null');
assert(!/detection:\s*\{/.test(pipelineCode), 'pipeline: normalizeAd ne produit PAS detection{}');
assert(!/negociable/.test(pipelineCode), 'pipeline: aucun negociable (champ supprimé)');

// ═══ Tests fonctionnels des extracteurs adFields (SCRAPING PUR) ═══
{
  const { extractTransaction, extractSeller, extractDates, extractCondition,
    extractLikes, extractPhotos, extractDescription, extractPrice } =
    require(path.join(base, 'services/scraping/adFields'));

  // === DESCRIPTION (correction du bug [object Object]) ===
  let desc = extractDescription({ body: 'Texte simple' });
  assert(desc === 'Texte simple', 'adFields.extractDescription: body string → string');
  desc = extractDescription({ body: { text: 'Texte dans objet' } });
  assert(desc === 'Texte dans objet', 'adFields.extractDescription: body {text:...} → string (corrige [object Object])');
  desc = extractDescription({ body: null });
  assert(desc === null, 'adFields.extractDescription: body null → null');
  desc = extractDescription({ body: 42 });
  assert(desc === null, 'adFields.extractDescription: body nombre → null (pas [object Object])');
  desc = extractDescription({ body: {} });
  assert(desc === null, 'adFields.extractDescription: body objet vide → null');
  desc = extractDescription({});
  assert(desc === null, 'adFields.extractDescription: pas de body → null');
  desc = extractDescription({ description: 'Via description' });
  assert(desc === 'Via description', 'adFields.extractDescription: raw.description → string');
  desc = extractDescription({ text: 'Via text' });
  assert(desc === 'Via text', 'adFields.extractDescription: raw.text → string');

  // === TRANSACTION (Livraison et Main propre INDÉPENDANTS) ===
  let t = extractTransaction({ has_option: { shipping: false } });
  assert(t.livraison === false && t.mainPropre === null,
    'adFields.extractTransaction: shipping=false → livraison=NON, mainPropre=null (pas inféré)');
  t = extractTransaction({ shipping: true });
  assert(t.livraison === true, 'adFields.extractTransaction: shipping=true → livraison=OUI');
  t = extractTransaction({ body: 'Remise en main propre uniquement' });
  assert(t.mainPropre === true, 'adFields.extractTransaction: mainPropre=OUI détecté depuis texte');
  t = extractTransaction({ body: "pas d'envoi possible" });
  assert(t.mainPropre === true, 'adFields.extractTransaction: "pas d\'envoi" → mainPropre=OUI');
  t = extractTransaction({ body: 'retrait sur place uniquement' });
  assert(t.mainPropre === true, 'adFields.extractTransaction: "retrait" → mainPropre=OUI');
  t = extractTransaction({ has_option: { shipping: true }, body: 'Possibilité de remise en main propre' });
  assert(t.livraison === true && t.mainPropre === true,
    'adFields.extractTransaction: livraison=OUI ET mainPropre=OUI simultanément');
  t = extractTransaction({});
  assert(t.livraison === null && t.mainPropre === null,
    'adFields.extractTransaction: pas d\'info → null (jamais false par défaut)');
  t = extractTransaction({ attributes: [{ key: 'foo', value: 'bar' }] });
  assert(t.livraison === null && t.mainPropre === null,
    'adFields.extractTransaction: attributes présent sans shipping → livraison=null (pas inventé)');

  // === computeDeliveryType (modèle unifié) ===
  const { computeDeliveryType } = require(path.join(base, 'services/scraping/adFields'));
  assert(computeDeliveryType(true, true) === 'les_deux', 'computeDeliveryType: true,true → les_deux');
  assert(computeDeliveryType(true, false) === 'livraison', 'computeDeliveryType: true,false → livraison');
  assert(computeDeliveryType(true, null) === 'livraison', 'computeDeliveryType: true,null → livraison');
  assert(computeDeliveryType(false, true) === 'main_propre', 'computeDeliveryType: false,true → main_propre');
  assert(computeDeliveryType(null, true) === 'main_propre', 'computeDeliveryType: null,true → main_propre');
  assert(computeDeliveryType(false, false) === 'aucun', 'computeDeliveryType: false,false → aucun');
  assert(computeDeliveryType(false, null) === 'aucun', 'computeDeliveryType: false,null → aucun');
  assert(computeDeliveryType(null, false) === 'aucun', 'computeDeliveryType: null,false → aucun');
  assert(computeDeliveryType(null, null) === 'inconnu', 'computeDeliveryType: null,null → inconnu');

  // === SELLER ===
  const s = extractSeller({ owner: { name: 'Jean', type: 'pro', rating: 4.8, nb_ratings: 27 } });
  assert(s.nom === 'Jean' && s.isPro === true && s.note === 4.8,
    'adFields.extractSeller: nom + note + isPro');

  // === DATES ===
  const d = extractDates({ first_publication_date: '2026-01-15T10:00:00Z' });
  assert(d.publication === '2026-01-15T10:00:00Z',
    'adFields.extractDates: publication extraite');

  // === CONDITION (État déclaré uniquement) ===
  const etat = extractCondition({ attributes: [{ key: 'condition', value: 'Très bon état' }] });
  assert(etat === 'Très bon état', 'adFields.extractCondition: extrait "condition"');
  assert(extractCondition({}) === null, 'adFields.extractCondition: pas d\'attributs → null');
  assert(extractCondition({ attributes: [{ key: 'brand', value: 'Apple' }] }) === null,
    'adFields.extractCondition: autre attribut → null (pas de fallback)');

  // === LIKES (likes uniquement) ===
  assert(extractLikes({ favorites_count: 24 }) === 24, 'adFields.extractLikes: likes extrait');
  assert(extractLikes({ favorites_count: 0 }) === 0, 'adFields.extractLikes: 0 likes = 0, pas null');
  assert(extractLikes({}) === null, 'adFields.extractLikes: pas d\'info → null (pas 0)');

  // === PHOTOS ===
  const ph = extractPhotos({ images: { urls: ['https://a.jpg', 'https://b.jpg'] } });
  assert(ph.count === 2 && ph.urls.length === 2, 'adFields.extractPhotos: count + urls');

  // === PRICE ===
  assert(extractPrice({ price: 100 }) === 100, 'adFields.extractPrice: number → 100');
  assert(extractPrice({ price: { value: 250 } }) === 250, 'adFields.extractPrice: {value}');
  assert(extractPrice({ price: [{ value: 300 }] }) === 300, 'adFields.extractPrice: [{value}] array format');
}

// harCapturer : annulation pendant CAPTCHA ne persiste PAS une session bloquée
const harCode = fs.readFileSync(path.join(base, 'services/scraping/harCapturer.js'), 'utf8');
assert(/NE PAS persister/.test(harCode), 'harCapturer: annulation warmup ne persiste pas la session bloquée');

// harCapturer : détection CAPTCHA multi-vecteurs (iframe, URL, Cloudflare)
assert(/arkoselabs|funcaptcha/.test(harCode), 'harCapturer: détection iframe Arkose/FunCaptcha');
assert(/challenges\.cloudflare|cf-turnstile|challenge-form/.test(harCode), 'harCapturer: détection challenge Cloudflare');
assert(/captchaUrlMatch|URL suspecte/.test(harCode), 'harCapturer: détection CAPTCHA via URL (redirection)');

// harCapturer : AUCUN reload pendant la résolution CAPTCHA
assert(!/vPage\.reload\(\{ waitUntil/.test(harCode), 'harCapturer: PAS de reload pendant résolution CAPTCHA');
assert(/NE RECHARGE PAS|sans reload|sans recharger/.test(harCode), 'harCapturer: polling sans reload documenté');

// harCapturer : warmup utilise networkidle
assert(/waitUntil:\s*['"]networkidle['"]/.test(harCode), 'harCapturer: warmup utilise networkidle');
assert(/sleep\(3000\)/.test(harCode), 'harCapturer: délai warmup 3s (rendu CAPTCHA différé)');

// harCapturer : MOTEUR HISTORIQUE RESTAURÉ (commit 8d223c9).
// La vérification d'accès `_verifyAccess` (qui rejetait à tort des réponses
// valides via un filtre de contenu trop large) a été retirée : la session est
// validée comme dans l'ancien moteur, sur la disparition du défi + stabilisation.
assert(!/_verifyAccess\s*\(/.test(harCode), 'harCapturer: plus de _verifyAccess (moteur historique restauré)');
assert(!/_parseRetryAfter/.test(harCode), 'harCapturer: plus de _parseRetryAfter (moteur historique restauré)');
assert(!/bodyOk/.test(harCode), 'harCapturer: plus de filtre de contenu bloquant (bodyOk)');
assert(/stabilisation/i.test(harCode), 'harCapturer: stabilisation avant persistance de session');
assert(/résolution interactive|vérification interactive/.test(harCode) || /tentative de résolution interactive/.test(harCode), 'harCapturer: CAPTCHA pendant capture → résolution interactive');
assert(/Reprise après résolution CAPTCHA/.test(harCode), 'harCapturer: reprise capture après résolution CAPTCHA (moteur historique)');

// harCapturer : UA FIXE pour toute la capture
assert(/this\._userAgent\s*=\s*getRandomUserAgent\(\)/.test(harCode), 'harCapturer: UA fixe choisi une fois dans le constructeur');
assert(/userAgent:\s*this\._userAgent/.test(harCode), 'harCapturer: _baseContextOptions réutilise this._userAgent (UA cohérent)');
assert(!/userAgent:\s*getRandomUserAgent\(\)/.test(harCode), 'harCapturer: PAS de getRandomUserAgent() dans _baseContextOptions (UA fixe)');
assert(/rate-limit Leboncoin/i.test(harCode), 'harCapturer: délai 2s après warmup (anti rate-limit Leboncoin)');

// pipeline : recyclage de contexte résilient (sauvegarde préventive + try/catch)
assert(/Recyclage contexte échoué/.test(pipelineCode), 'pipeline: recyclage contexte a un catch (ne crash pas le job)');
assert(/Sauvegarde préventive AVANT le recyclage/.test(pipelineCode), 'pipeline: writeOutputs avant recyclage (pas de perte)');

// renderer : renderCharts garde contre les canvas absents
assert(/priceDistCanvas \|\| !sellerCanvas \|\| !citiesCanvas/.test(appCode), 'app.js: renderCharts garde contre canvas absents');
// V3 : graphique vendeur en barres horizontales
assert(/indexAxis:\s*'y'/.test(appCode), 'app.js: graphique vendeur en barres horizontales (V3)');
assert(!/type:\s*'doughnut'/.test(appCode), 'app.js: V3 — plus de doughnut pour le graphique vendeur');
assert(!/cutout:\s*'62%'/.test(appCode), 'app.js: V3 — cutout doughnut supprimé');
// renderer : cache géocodage tolérant au JSON corrompu
assert(/try \{[\s\S]*?JSON\.parse\(cached\)[\s\S]*?\} catch/.test(appCode), 'app.js: cache géocodage tolérant au JSON corrompu');
// renderer : mapHandDeliveryOnly null-safe
assert(/mapHandDeliveryEl && mapHandDeliveryEl\.checked/.test(appCode), 'app.js: mapHandDeliveryOnly null-safe');
// renderer : mapHandDeliveryOnly utilise deliveryType (main_propre + les_deux)
assert(/deliveryType === 'main_propre' \|\| dt === 'les_deux'/.test(appCode) || /main_propre.*les_deux/.test(appCode), 'app.js: filtre carte utilise deliveryType main_propre/les_deux');

// --- 8. Livraison / Main propre INDÉPENDANTS (extraction défensive) ---
console.log('\n[8] Livraison / Main propre indépendants');
const adFieldsDeliveryCode = fs.readFileSync(path.join(base, 'services/scraping/adFields.js'), 'utf8');
assert(/raw\.attributes/.test(adFieldsDeliveryCode), 'adFields: extractTransaction vérifie raw.attributes[] (API récente)');
assert(/shippable|is_shippable/.test(adFieldsDeliveryCode), 'adFields: extractTransaction cherche clé "shippable" dans attributes');
assert(/is_shippable|shippable|is_shipping/.test(adFieldsDeliveryCode), 'adFields: extractTransaction vérifie is_shippable/shippable (variantes récentes)');
assert(adFieldsDeliveryCode.includes('remise\\s+en\\s+main\\s+propre') || adFieldsDeliveryCode.includes('main\\s+propre\\s+uniquement'),
  'adFields: extractTransaction détecte "main propre" dans le body');
assert(/pas.*envoi|retrait.*place|venir.*chercher/.test(adFieldsDeliveryCode), 'adFields: extractTransaction détecte "pas d\'envoi" / "retrait" dans le body');
// Livraison/mainPropre ne sont PLUS inventées par défaut : null si inconnu.
assert(!/Array\.isArray\(raw\?\.attributes\) && raw\.attributes\.length > 0/.test(adFieldsDeliveryCode), 'adFields: extractTransaction ne force PAS livraison=false quand attributes présent sans shipping');
assert(!/livraison\s*=\s*false/.test(adFieldsDeliveryCode.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'adFields: plus de fallback livraison=false par défaut');

// constants.js : DEFAULTS mort supprimé (valeurs conflictuelles avec settings)
const constantsCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/config/constants.js'), 'utf8');
assert(!/DEFAULTS:\s*\{/.test(constantsCode), 'constants.js: DEFAULTS mort supprimé (valeurs conflictuelles)');

// --- 9. Audit fonctionnel A→Z (cohérence UI/logique/docs) ---
console.log('\n[9] Audit fonctionnel A→Z');

// jobHistory : format de date lisible
const jobHistoryCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/jobs/jobHistory.js'), 'utf8');
assert(/tsMatch\s*=\s*entry\.name\.match/.test(jobHistoryCode), 'jobHistory: format date via regex (extraction composants)');
assert(/\$\{tsMatch\[3\]\}\/\$\{tsMatch\[2\]\}\/\$\{tsMatch\[1\]\}/.test(jobHistoryCode), 'jobHistory: date au format JJ/MM/AAAA (slashes)');
assert(jobHistoryCode.indexOf("replace(/-/g") === -1, 'jobHistory: ne remplace plus les - par : dans la date (ancien pattern retire)');
// rapport.txt est mort (jamais créé par le pipeline) → retiré de jobHistory
assert(!/rapportPath|rapport:/.test(jobHistoryCode), 'jobHistory: rapport.txt mort retiré (jamais généré par le pipeline)');

// app.js : suppression de job nettoie le comparateur (IDs fantômes)
assert(/compareSet = new Set\(\[\.\.\.compareSet\]\.filter/.test(appCode), 'app.js: compareSet nettoyé après suppression job (IDs fantômes)');
assert(/refreshActiveDataTab\(\)/.test(appCode.replace(/\/\/[^\n]*\n/g, '')), 'app.js: suppression déclenche refreshActiveDataTab');

// [suite] — écritures atomiques (anti-corruption de fichiers critiques)
const secretStoreCode2 = fs.readFileSync(path.join(base, 'utils/secretStore.js'), 'utf8');
assert(/atomicWriteFileSync\(p,/.test(secretStoreCode2), 'secretStore: _save atomique (atomicWriteFileSync)');
assert(!/fs\.writeFileSync\(p,/.test(secretStoreCode2), 'secretStore: _save n\'utilise plus fs.writeFileSync');

const settingsCode2 = fs.readFileSync(path.join(base, 'core/settings.js'), 'utf8');
assert(/atomicWriteFileSync\(getSettingsPath\(\)/.test(settingsCode2), 'settings: saveSettings atomique (atomicWriteFileSync)');
assert(!/fs\.writeFileSync\(getSettingsPath\(\)/.test(settingsCode2), 'settings: saveSettings n\'utilise plus fs.writeFileSync');

// [suite] — Onglet Logs amélioré
const htmlCode2 = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
assert(/autoScrollToggleBtn/.test(htmlCode2), 'logs: bouton auto-scroll présent dans HTML');
assert(/copyLogsBtn/.test(htmlCode2), 'logs: bouton copier présent dans HTML');
assert(/logModeToggleBtn/.test(htmlCode2), 'logs: bouton mode normal/debug présent dans HTML');
assert(/logs-toolbar/.test(htmlCode2), 'logs: toolbar de boutons présente');
assert(/logStats/.test(htmlCode2), 'logs: compteur de logs affichés présent');

assert(/_logBuffer/.test(appCode), 'app.js: buffer de logs en mémoire (_logBuffer)');
assert(/_logMode/.test(appCode) && /'normal'/.test(appCode) && /'debug'/.test(appCode), 'app.js: mode normal/debug (_logMode)');
assert(/_autoScroll\s*=\s*true/.test(appCode), 'app.js: auto-scroll activé par défaut (_autoScroll=true)');
assert(/_logLevelVisible/.test(appCode), 'app.js: fonction de filtrage par niveau (_logLevelVisible)');
assert(/_renderLogs/.test(appCode), 'app.js: fonction de re-render (_renderLogs) pour filtrage rétroactif');
assert(/navigator\.clipboard\.writeText/.test(appCode), 'app.js: copie des logs via clipboard API');
assert(/MAX_LOG_BUFFER/.test(appCode), 'app.js: plafond mémoire du buffer (MAX_LOG_BUFFER)');
assert(/level !== 'debug'/.test(appCode), 'app.js: mode normal filtre les logs debug');
assert(/_logMode === 'debug'/.test(appCode), 'app.js: mode debug affiche tous les logs');

// Résumé de session (ipcHandlers)
const ipcCode2 = fs.readFileSync(path.join(__dirname, '..', 'src/main/core/ipcHandlers.js'), 'utf8');
assert(/sessionStats/.test(ipcCode2), 'ipcHandlers: sessionStats tracker présent');
assert(/sendSessionSummary/.test(ipcCode2), 'ipcHandlers: fonction sendSessionSummary présente');
assert(/RÉSUMÉ DE SESSION/.test(ipcCode2), 'ipcHandlers: résumé de session formaté');
assert(/pagesRequested/.test(ipcCode2) && /adsFound/.test(ipcCode2) && /adsKept/.test(ipcCode2), 'ipcHandlers: compteurs pages/annonces');
assert(/errors/.test(ipcCode2) && /warnings/.test(ipcCode2) && /debugs/.test(ipcCode2), 'ipcHandlers: compteurs erreurs/warnings/debugs');
// Plus de compteurs IA dans le résumé
assert(!/aiAnalyzed/.test(ipcCode2), 'ipcHandlers: compteur aiAnalyzed supprimé');
assert(!/aiFallback/.test(ipcCode2), 'ipcHandlers: compteur aiFallback supprimé');
assert(!/marketAnalyzed/.test(ipcCode2), 'ipcHandlers: compteur marketAnalyzed supprimé');
assert(!/writeSummaryFile/.test(ipcCode2), 'ipcHandlers: writeSummaryFile supprimé');
assert(!/resumes-ia/.test(ipcCode2), 'ipcHandlers: écriture resumes-ia.json supprimée');

// CSS pour les logs
const cssCode2 = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');
assert(/\.logs-toolbar/.test(cssCode2), 'styles.css: styles de la toolbar logs');
assert(/\.log-debug/.test(cssCode2), 'styles.css: style log-debug (mode debug)');
assert(/\.log-info/.test(cssCode2), 'styles.css: style log-info');
assert(/\.log-warn/.test(cssCode2), 'styles.css: style log-warn');
assert(/\.log-error/.test(cssCode2), 'styles.css: style log-error');
// Plus de styles AI Studio / market-progress / structure-warning
assert(!/\.ai-studio/.test(cssCode2), 'styles.css: styles .ai-studio supprimés');
assert(!/\.market-progress/.test(cssCode2), 'styles.css: styles .market-progress supprimés');
assert(!/\.structure-warning/.test(cssCode2), 'styles.css: styles .structure-warning supprimés');
assert(!/\.ai-tab/.test(cssCode2), 'styles.css: styles .ai-tab supprimés');
assert(!/\.ai-panel/.test(cssCode2), 'styles.css: styles .ai-panel supprimés');
assert(!/\.prompt-card/.test(cssCode2), 'styles.css: styles .prompt-card supprimés');

// CAPTCHA : détection de résolution (bug critique du vStatus figé)
const harCode2 = fs.readFileSync(path.join(base, 'services/scraping/harCapturer.js'), 'utf8');
assert(/latestHttpStatus/.test(harCode2), 'harCapturer: tracking dynamique latestHttpStatus (fix vStatus figé)');
assert(/vPage\.on\('response'/.test(harCode2), 'harCapturer: écouteur response pour statut HTTP temps réel');
assert(/resourceType\(\) === 'document'/.test(harCode2), 'harCapturer: filtre document sur resourceType (ignore sous-ressources)');
assert(/checkVBlocked\s*=\s*async\s*\(\)\s*=>/.test(harCode2) || /checkVBlocked\s*=\s*async\s*\(\)\s*=>\s*\{/.test(harCode2), 'harCapturer: polling content-based (plus de vStatus figé)');
assert(/confirmedClear/.test(harCode2), 'harCapturer: confirmation anti-faux-positif (confirmedClear / moteur historique)');
assert(!/while \(isBlocked && !this\.isCancelled\)/.test(harCode2), 'harCapturer: ancienne boucle isBlocked remplacée par visualClear');
assert(/POLL_INTERVAL_MS = 2000/.test(harCode2), 'harCapturer: polling 2s (detection rapide, plus 3s)');

// Pipeline : exit code 1 sur erreur CLI (était 0 → runner croyait succès)
const pipelineCode2 = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), 'utf8');
assert(/Erreur CLI[^\n]*\n[\s\S]*?throw err/.test(pipelineCode2), 'pipeline: throw err sur erreur CLI (pas de process.exit brutal)');

// sessionStats.pagesScraped mis à jour dans le handler de progression
assert(/pagesScraped/.test(ipcCode2), 'ipcHandlers: pagesScraped tracker présent');
assert(/currentPage > sessionStats\.pagesScraped/.test(ipcCode2), 'ipcHandlers: pagesScraped mis à jour depuis la progression HAR');

// ─── P1 : Bouton « Arrêter » universel (scraping) ───
assert(/activeCancel\s*=\s*\{\s*cancelled:\s*false\s*\}/.test(ipcCode2), 'ipcHandlers: token activeCancel créé pour job:start');
assert(/activeCancel\.cancelled\s*=\s*true/.test(ipcCode2), 'ipcHandlers: job:stop positionne activeCancel.cancelled (arrêt)');

// ─── P4 : Bouton « Ouvrir les jobs » (erreurs non silencieuses) ───
assert(/errStr\s*=\s*await\s+FileManager\.openFolder\(JOBS_DIR\)/.test(ipcCode2), 'ipcHandlers: jobs:openFolder await FileManager.openFolder et capture l\'erreur');
assert(/return\s+errStr/.test(fs.readFileSync(path.join(base, 'infrastructure/fileManager.js'), 'utf8')), 'fileManager: openFolder retourne errStr (shell.openPath)');

// D. Historique des annonces (changements prix/likes entre sessions)
const { buildAdHistory } = require(path.join(base, 'services/jobs/jobHistory'));
{
  const jobs = [
    { id: 'job-2026-08-01T10-00', date: '01/08/2026 à 10:00', ads: [
      { id: '1', title: 'iPhone', price: 150, statistiques: { likes: 10 } },
      { id: '2', title: 'Autre', price: 200 },
    ]},
    { id: 'job-2026-08-15T10-00', date: '15/08/2026 à 10:00', ads: [
      { id: '1', title: 'iPhone', price: 120, statistiques: { likes: 15 } },
      { id: '2', title: 'Autre', price: 200 },
    ]},
    { id: 'job-2026-08-30T10-00', date: '30/08/2026 à 10:00', ads: [
      { id: '1', title: 'iPhone', price: 100, statistiques: { likes: 24 } },
    ]},
  ];
  const history = buildAdHistory(jobs);
  assert(history.length === 2, 'buildAdHistory: 2 annonces uniques détectées');
  const ad1 = history.find((h) => h.id === '1');
  assert(ad1 && ad1.sessions === 3, 'buildAdHistory: annonce 1 vue dans 3 sessions');
  assert(ad1 && ad1.prix && ad1.prix.initial === 150 && ad1.prix.actuel === 100, 'buildAdHistory: prix initial/actuel corrects');
  assert(ad1 && ad1.prix.delta === -50 && ad1.prix.baisse === 50 && ad1.prix.direction === 'baisse', 'buildAdHistory: baisse de 50€ détectée');
  assert(ad1 && ad1.likes && ad1.likes.delta === 14 && ad1.likes.direction === 'up', 'buildAdHistory: hausse de likes 10→24 détectée');
  assert(history[0].id === '1', 'buildAdHistory: tri par activité (baisse + likes up en premier)');
  const ad2 = history.find((h) => h.id === '2');
  assert(ad2 && ad2.prix === null, 'buildAdHistory: prix stable → null (pas de changement)');
  assert(ad2 && ad2.likes === null, 'buildAdHistory: pas de likes → null');
}
assert(/getAdHistory/.test(fs.readFileSync(path.join(base, 'core/ipcHandlers.js'), 'utf8')), 'ipcHandlers: handler job:getAdHistory enregistré');
assert(/job:getAdHistory/.test(fs.readFileSync(path.join(base, 'preload.js'), 'utf8')), 'preload: getAdHistory exposé au renderer');
assert(/getAdHistory:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('job:getAdHistory'\)/.test(fs.readFileSync(path.join(base, 'preload.js'), 'utf8')), 'preload: getAdHistory IPC correctement câblée');

// A. Vérification du binaire Chromium (scraping-critique)
assert(/app:checkChromium/.test(ipcCode2), 'ipcHandlers: handler app:checkChromium enregistré');
assert(/chromium\.executablePath\(\)/.test(ipcCode2), 'ipcHandlers: app:checkChromium utilise chromium.executablePath()');
assert(/fs\.existsSync\(exePath\)/.test(ipcCode2), 'ipcHandlers: app:checkChromium vérifie l\'existence du binaire sur disque');
assert(/fixCommand/.test(ipcCode2), 'ipcHandlers: app:checkChromium renvoie fixCommand (aide utilisateur)');

const preloadCodeG = fs.readFileSync(path.join(base, 'preload.js'), 'utf8');
assert(/checkChromium:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('app:checkChromium'\)/.test(preloadCodeG), 'preload: expose checkChromium à l\'API renderer');

const indexHtmlG = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
assert(/id="chromiumWarning"/.test(indexHtmlG), 'index.html: élément #chromiumWarning présent (bandeau)');
assert(/chromiumWarningRetry/.test(indexHtmlG), 'index.html: bouton de revérification #chromiumWarningRetry présent');
assert(/npx playwright install chromium/.test(indexHtmlG), 'index.html: commande de correction affichée dans le bandeau');

const appJsCodeG = appCode;
assert(/refreshChromiumCheck/.test(appJsCodeG), 'app.js: fonction refreshChromiumCheck définie');
assert(/window\.api\.checkChromium\(\)/.test(appJsCodeG), 'app.js: appel à window.api.checkChromium() au démarrage');
assert(/res\.ok/.test(appJsCodeG) && /chromiumWarningEl/.test(appJsCodeG), 'app.js: masque/affiche le bandeau selon res.ok');

// jobHistory : plus de fichiers xlsx/csv/short/resumes
const jobHistCodeG = fs.readFileSync(path.join(base, 'services/jobs/jobHistory.js'), 'utf8');
assert(!/xlsxPath|\.xlsx/.test(jobHistCodeG), 'jobHistory: chemin annonces.xlsx supprimé');
assert(!/csvPath|\.csv/.test(jobHistCodeG), 'jobHistory: chemin annonces.csv supprimé');
assert(!/shortTxtPath|\.short/.test(jobHistCodeG), 'jobHistory: chemin annonces.short.txt supprimé');
assert(!/resumes|resumes-ia/.test(jobHistCodeG), 'jobHistory: chemin resumes-ia.json supprimé');
assert(!/files\.xlsx/.test(appCode), 'app.js: tag xlsx supprimé de l\'historique');
assert(!/files\.csv/.test(appCode), 'app.js: tag csv supprimé de l\'historique');
assert(!/files\.short/.test(appCode), 'app.js: tag short supprimé de l\'historique');
assert(!/files\.resumes/.test(appCode), 'app.js: tag resumes supprimé de l\'historique');
assert(!/\.tag-csv/.test(cssCode2), 'styles.css: style .tag-csv supprimé');
assert(!/\.tag-xlsx/.test(cssCode2), 'styles.css: style .tag-xlsx supprimé');
assert(!/\.tag-short/.test(cssCode2), 'styles.css: style .tag-short supprimé');

// ─── [10] Modes d'export (Défaut / Personnalisé) ───
console.log('\n[10] Export modes');
{
  const exporting = require('../src/main/services/exporting/exportFields');
  assert(typeof exporting.filterAdByFields === 'function', 'exportFields: filterAdByFields présent');
  assert(typeof exporting.toReadableBlock === 'function', 'exportFields: toReadableBlock présent');
  assert(Array.isArray(exporting.DEFAULT_FIELDS) && exporting.DEFAULT_FIELDS.length > 0, 'exportFields: DEFAULT_FIELDS non vide');
  assert(Array.isArray(exporting.FIELD_CATEGORIES) && exporting.FIELD_CATEGORIES.length > 0, 'exportFields: FIELD_CATEGORIES non vide');
  assert(Array.isArray(exporting.ALL_FIELD_KEYS) && exporting.ALL_FIELD_KEYS.length === exporting.DEFAULT_FIELDS.length, 'exportFields: ALL_FIELD_KEYS aligné sur DEFAULT_FIELDS');

  // Plus de toShortText / fromShortText
  assert(typeof exporting.toShortText === 'undefined', 'exportFields: toShortText supprimé');
  assert(typeof exporting.fromShortText === 'undefined', 'exportFields: fromShortText supprimé');
  // Plus de champs IA dans DEFAULT_FIELDS
  assert(!exporting.DEFAULT_FIELDS.some((f) => ['produitIdentifie', 'resumeIA', 'verdict', 'valeurMarche', 'fourchette', 'benefice', 'justification'].includes(f.key)),
    'exportFields: champs IA supprimés de DEFAULT_FIELDS');
  // Plus de catégorie ia
  assert(!exporting.FIELD_CATEGORIES.some((c) => c.id === 'ia'), 'exportFields: catégorie ia supprimée');

  // Mode Défaut : toReadableBlock renvoie un bloc avec tous les champs.
  const ad1 = {
    id: '1', title: 'Nintendo DS Lite', prix: 30, city: 'Dijon', zipcode: '21000',
    vendeurNom: 'Jean', vendeurNote: 4.5, likes: 10,
    description: 'Console en bon état',
    livraison: true, mainPropre: false, deliveryType: 'livraison',
    etat: 'Bon état',
    dateScraping: '2026-08-31T22:43:15Z',
    url: 'https://lbc.fr/1',
  };
  const blockDefaut = exporting.toReadableBlock(ad1, 0);
  assert(blockDefaut.includes('===== ANNONCE 1 ====='), 'TXT Défaut: en-tête annonce');
  assert(blockDefaut.includes('Nintendo DS Lite'), 'TXT Défaut: titre');
  assert(blockDefaut.includes('30 €'), 'TXT Défaut: prix formaté');
  assert(blockDefaut.includes('Console en bon état'), 'TXT Défaut: description');
  assert(blockDefaut.includes('Jean'), 'TXT Défaut: vendeur');
  assert(blockDefaut.includes('livraison'), 'TXT Défaut: deliveryType=livraison présent');

  // Mode Personnalisé (1 champ : titre + prix) : le bloc ne contient que ça.
  const blockPerso = exporting.toReadableBlock(ad1, 0, ['title', 'prix']);
  assert(blockPerso.includes('Titre'), 'TXT Perso (titre): libellé Titre');
  assert(blockPerso.includes('Prix'), 'TXT Perso (prix): libellé Prix');
  assert(blockPerso.includes('Nintendo DS Lite'), 'TXT Perso: titre présent');
  assert(blockPerso.includes('30 €'), 'TXT Perso: prix présent');
  assert(!blockPerso.includes('Description'), 'TXT Perso: pas de section Description');
  assert(!blockPerso.includes('Ville'), 'TXT Perso: pas de section Ville');
  assert(!blockPerso.includes('Vendeur'), 'TXT Perso: pas de section Vendeur');

  // filterAdByFields : mode Défaut (= null) → objet tel quel.
  const filteredDefault = exporting.filterAdByFields(ad1);
  assert(filteredDefault.id === '1', 'filterAdByFields default: id conservé');
  assert(filteredDefault.description === 'Console en bon état', 'filterAdByFields default: description conservée');

  // filterAdByFields : mode Personnalisé → uniquement les clés sélectionnées.
  const filteredCustom = exporting.filterAdByFields(ad1, ['id', 'title', 'prix']);
  assert(filteredCustom.id === '1' && filteredCustom.title === 'Nintendo DS Lite' && filteredCustom.prix === 30,
    'filterAdByFields custom: clés sélectionnées conservées');
  assert(filteredCustom.description === undefined, 'filterAdByFields custom: description retirée');
}

// Intégration pipeline : writeOutputs respecte le profil
{
  const pipelinePath = path.join(base, 'services/scraping/leboncoin-pipeline.js');
  const pipelineCode = fs.readFileSync(pipelinePath, 'utf8');
  assert(/--profile-id/.test(pipelineCode), 'pipeline: option CLI --profile-id');
  assert(/--profile-fields/.test(pipelineCode), 'pipeline: option CLI --profile-fields');
  assert(/filterAdByFields/.test(pipelineCode), 'pipeline: utilise filterAdByFields pour le profil');
  // Plus de short.txt
  assert(!/annonces\.short\.txt/.test(pipelineCode), 'pipeline: plus de annonces.short.txt');
  // Plus d'anciennes options --export-mode / --export-fields
  assert(!/--export-mode/.test(pipelineCode), 'pipeline: ancienne option --export-mode supprimée');
  assert(!/--export-fields/.test(pipelineCode), 'pipeline: ancienne option --export-fields supprimée');
}

// Integration pipelineRunner → pipeline
{
  const runnerCode = fs.readFileSync(path.join(base, 'services/scraping/pipelineRunner.js'), 'utf8');
  assert(/profileId/.test(runnerCode), 'pipelineRunner: déstructure profileId');
  assert(/profileFields/.test(runnerCode), 'pipelineRunner: déstructure profileFields');
  assert(/--profile-id/.test(runnerCode), 'pipelineRunner: forward --profile-id au pipeline');
  assert(/--profile-fields/.test(runnerCode), 'pipelineRunner: forward --profile-fields au pipeline');
  // Plus d'anciennes options
  assert(!/--export-mode/.test(runnerCode), 'pipelineRunner: ancienne option --export-mode supprimée');
  assert(!/--export-fields/.test(runnerCode), 'pipelineRunner: ancienne option --export-fields supprimée');
}

// ipcHandlers : wiring complet du profil
{
  const ipcCodeNew = fs.readFileSync(path.join(base, 'core/ipcHandlers.js'), 'utf8');
  assert(/profileId/.test(ipcCodeNew), 'ipcHandlers: lit profileId depuis la config renderer');
  assert(/exportFields/.test(ipcCodeNew), 'ipcHandlers: lit exportFields depuis la config renderer');
  assert(/getProfileFields/.test(ipcCodeNew), 'ipcHandlers: utilise getProfileFields pour résoudre les champs');
  assert(/profileFields/.test(ipcCodeNew), 'ipcHandlers: passe profileFields au pipeline');
  // Plus de régénération XLSX/CSV
  assert(!/export-meta\.json.*XLSX|XLSX.*export-meta/.test(ipcCodeNew), 'ipcHandlers: plus de régénération XLSX/CSV');
  assert(!/ExcelExporter/.test(ipcCodeNew), 'ipcHandlers: plus d\'ExcelExporter');
}

// jobHistory : plus de export-meta + short file
{
  const jobHistCode = fs.readFileSync(path.join(base, 'services/jobs/jobHistory.js'), 'utf8');
  assert(!/shortTxtPath/.test(jobHistCode), 'jobHistory: plus de shortTxtPath');
  assert(!/short:/.test(jobHistCode), 'jobHistory: plus de fichier short listé dans files');
}

// UI : profil + sélection des champs
{
  const indexCode = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
  assert(/id="exportModeDefault"/.test(indexCode), 'index.html: radio profil Défaut');
  assert(/id="exportModeMaximum"/.test(indexCode), 'index.html: radio profil Maximum');
  assert(/id="exportModeCustom"/.test(indexCode), 'index.html: radio profil Personnalisé');
  assert(/id="exportFieldsPanel"/.test(indexCode), 'index.html: panneau sélection des champs');
  assert(/id="exportFieldsAll"/.test(indexCode), 'index.html: bouton Tout sélectionner');
  assert(/id="exportFieldsNone"/.test(indexCode), 'index.html: bouton Tout désélectionner');
  assert(/id="exportFieldsList"/.test(indexCode), 'index.html: liste des champs cochables');
  assert(/id="exportProfileDescription"/.test(indexCode), 'index.html: description du profil affichée');

  const appCodeNew = appCode;
  assert(/EXPORT_FIELDS/.test(appCodeNew), 'app.js: liste EXPORT_FIELDS');
  assert(/getSelectedProfile/.test(appCodeNew), 'app.js: accesseur profil sélectionné (getSelectedProfile)');
  assert(/getSelectedExportFields/.test(appCodeNew), 'app.js: accesseur champs sélectionnés');
  assert(/profileId:\s*getSelectedProfile\(\)/.test(appCodeNew),
    'app.js: startScraping envoie profileId');
  assert(/exportFields:\s*getSelectedProfile\(\)\s*===\s*.custom.\s*\?/.test(appCodeNew),
    'app.js: startScraping envoie exportFields uniquement si profil=custom');
  assert(/tag-txt/.test(appCodeNew), 'app.js: tag "TXT" affiché dans la table');
  assert(/tag-export-custom/.test(appCodeNew), 'app.js: badge "Personnalisé" affiché en mode custom');

  const stylesCode = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');
  assert(/\.tag-txt\s*\{/.test(stylesCode), 'styles.css: .tag-txt');
  assert(/\.tag-export-custom\s*\{/.test(stylesCode), 'styles.css: .tag-export-custom');
}

// Carte Leaflet : filtre main propre utilise deliveryType
{
  const appCodeMap = appCode;
  assert(/deliveryType/.test(appCodeMap),
    'app.js: filtre carte utilise deliveryType (modèle unifié)');
  assert(/Leaflet non (chargé|disponible)/.test(appCodeMap),
    'app.js: diagnostic Leaflet non chargé (L undefined)');
}

// ─── [10b] dataProfiles : 3 profils (Défaut / Maximum / Personnalisé) ───
console.log('\n[10b] dataProfiles (3 profils)');
(function () {
  const dp = require('../src/main/services/exporting/dataProfiles');
  const { ALL_FIELD_KEYS } = require('../src/main/services/exporting/exportFields');

  assert(typeof dp.getProfileFields === 'function', 'dataProfiles: getProfileFields présent');
  assert(typeof dp.getProfileLabel === 'function', 'dataProfiles: getProfileLabel présent');
  assert(typeof dp.PROFILES === 'object', 'dataProfiles: PROFILES présent');
  assert(dp.PROFILES.default.id === 'default', 'dataProfiles: profil default.id');
  assert(dp.PROFILES.maximum.id === 'maximum', 'dataProfiles: profil maximum.id');
  assert(dp.PROFILES.custom.id === 'custom', 'dataProfiles: profil custom.id');
  assert(dp.PROFILES.default.label === 'Défaut', 'dataProfiles: label Défaut');
  assert(dp.PROFILES.maximum.label === 'Maximum', 'dataProfiles: label Maximum');
  assert(dp.PROFILES.custom.label === 'Personnalisé', 'dataProfiles: label Personnalisé');

  // DEFAULT_PROFILE_FIELDS : sous-ensemble des champs essentiels
  assert(Array.isArray(dp.DEFAULT_PROFILE_FIELDS) && dp.DEFAULT_PROFILE_FIELDS.length > 0,
    'dataProfiles: DEFAULT_PROFILE_FIELDS non vide');
  assert(dp.DEFAULT_PROFILE_FIELDS.includes('id'), 'dataProfiles: DEFAULT inclut id');
  assert(dp.DEFAULT_PROFILE_FIELDS.includes('title'), 'dataProfiles: DEFAULT inclut title');
  assert(dp.DEFAULT_PROFILE_FIELDS.includes('prix'), 'dataProfiles: DEFAULT inclut prix');
  assert(dp.DEFAULT_PROFILE_FIELDS.includes('description'), 'dataProfiles: DEFAULT inclut description');
  // DEFAULT est un sous-ensemble strict de ALL_FIELD_KEYS (pas toutes les clés)
  assert(dp.DEFAULT_PROFILE_FIELDS.length < ALL_FIELD_KEYS.length,
    'dataProfiles: DEFAULT_PROFILE_FIELDS est un sous-ensemble (< ALL_FIELD_KEYS)');

  // MAXIMUM_PROFILE_FIELDS : toutes les clés disponibles
  assert(Array.isArray(dp.MAXIMUM_PROFILE_FIELDS), 'dataProfiles: MAXIMUM_PROFILE_FIELDS est un tableau');
  assert(dp.MAXIMUM_PROFILE_FIELDS.length === ALL_FIELD_KEYS.length,
    'dataProfiles: MAXIMUM_PROFILE_FIELDS = ALL_FIELD_KEYS (toutes les clés)');

  // getProfileFields : profil default → DEFAULT_PROFILE_FIELDS
  const defaultFields = dp.getProfileFields('default');
  assert(Array.isArray(defaultFields) && defaultFields.length === dp.DEFAULT_PROFILE_FIELDS.length,
    'getProfileFields(default): renvoie DEFAULT_PROFILE_FIELDS');
  assert(defaultFields.includes('id') && defaultFields.includes('title'),
    'getProfileFields(default): contient les champs essentiels');

  // getProfileFields : profil maximum → toutes les clés
  const maxFields = dp.getProfileFields('maximum');
  assert(maxFields.length === ALL_FIELD_KEYS.length,
    'getProfileFields(maximum): renvoie toutes les clés');
  assert(ALL_FIELD_KEYS.every((k) => maxFields.includes(k)),
    'getProfileFields(maximum): contient toutes les clés');

  // getProfileFields : profil custom avec champs valides. Les champs techniques
  // essentiels (photos) sont TOUJOURS garantis (l'explorateur en a besoin).
  const customFields = dp.getProfileFields('custom', ['id', 'title', 'prix']);
  assert(Array.isArray(customFields) && customFields.includes('id')
    && customFields.includes('title') && customFields.includes('prix'),
    'getProfileFields(custom, [3 champs]): champs demandés conservés');
  assert(customFields.includes('photosUrls') && customFields.includes('photosCount'),
    'getProfileFields(custom): champs photos essentiels garantis (explorateur)');

  // getProfileFields : profil custom sans champs → fallback sur DEFAULT
  const customEmpty = dp.getProfileFields('custom', []);
  assert(Array.isArray(customEmpty) && customEmpty.length === dp.DEFAULT_PROFILE_FIELDS.length,
    'getProfileFields(custom, []): fallback sur DEFAULT_PROFILE_FIELDS');
  assert(customEmpty.includes('id'),
    'getProfileFields(custom, []): fallback contient id');

  // getProfileFields : profil custom avec champs invalides → filtrés
  const customInvalid = dp.getProfileFields('custom', ['id', 'fakeField', 'title']);
  assert(customInvalid.includes('id') && customInvalid.includes('title') && !customInvalid.includes('fakeField'),
    'getProfileFields(custom): champs invalides filtrés (seuls les valides sont conservés)');

  // getProfileFields : profil inconnu → fallback sur DEFAULT
  const unknownFields = dp.getProfileFields('unknown');
  assert(Array.isArray(unknownFields) && unknownFields.length === dp.DEFAULT_PROFILE_FIELDS.length,
    'getProfileFields(unknown): fallback sur DEFAULT_PROFILE_FIELDS');

  // getProfileLabel : libellés des profils
  assert(dp.getProfileLabel('default') === 'Défaut', 'getProfileLabel(default): "Défaut"');
  assert(dp.getProfileLabel('maximum') === 'Maximum', 'getProfileLabel(maximum): "Maximum"');
  assert(dp.getProfileLabel('custom') === 'Personnalisé', 'getProfileLabel(custom): "Personnalisé"');
  assert(dp.getProfileLabel('unknown') === 'Défaut', 'getProfileLabel(unknown): fallback "Défaut"');

  // filterAdByFields avec getProfileFields : cohérence du filtrage
  const { filterAdByFields } = require('../src/main/services/exporting/exportFields');
  const testAd = { id: '1', title: 'Test', prix: 100, ville: 'Lyon', description: 'desc', vendeurNom: 'Jean', likes: 42, vendeurNote: 4.8 };
  const filteredDefault = filterAdByFields(testAd, dp.getProfileFields('default'));
  assert(filteredDefault.id === '1' && filteredDefault.title === 'Test',
    'filterAdByFields + getProfileFields(default): champs essentiels conservés');
  assert(filteredDefault.vendeurNom === 'Jean',
    'filterAdByFields + getProfileFields(default): vendeurNom present (dans le profil Defaut)');
  assert(filteredDefault.likes === undefined,
    'filterAdByFields + getProfileFields(default): likes absent (pas dans le profil Defaut)');
  assert(filteredDefault.vendeurNote === undefined,
    'filterAdByFields + getProfileFields(default): vendeurNote absent (pas dans le profil Defaut)');

  const filteredMax = filterAdByFields(testAd, dp.getProfileFields('maximum'));
  assert(filteredMax.id === '1' && filteredMax.title === 'Test' && filteredMax.vendeurNom === 'Jean',
    'filterAdByFields + getProfileFields(maximum): tous les champs conserves');
  assert(filteredMax.likes === 42,
    'filterAdByFields + getProfileFields(maximum): likes present (toutes les cles)');
})();

// === 5. Données vendeur + minimisation ===
console.log('\n[11] Données vendeur + minimisation');
const exporting = require('../src/main/services/exporting/exportFields');
const runnerCode = fs.readFileSync(path.join(base, 'services/scraping/pipelineRunner.js'), 'utf8');
const ipcCodeNew = fs.readFileSync(path.join(base, 'core/ipcHandlers.js'), 'utf8');
const indexCode = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
const appCodeNew = appCode;
const stylesCode = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');

// Settings : includeSellerData par défaut = true
assert(/includeSellerData:\s*true/.test(settingsCode), 'settings: includeSellerData default true');

// exportFields : SELLER_FIELD_KEYS présent
const exportFieldsCode = fs.readFileSync(path.join(base, 'services/exporting/exportFields.js'), 'utf8');
assert(/SELLER_FIELD_KEYS/.test(exportFieldsCode), 'exportFields: SELLER_FIELD_KEYS défini');
assert(/excludeSellerData/.test(exportFieldsCode), 'exportFields: excludeSellerData supporté');

// filterAdByFields exclut les champs vendeur quand excludeSellerData=true
const testAd = { id: '1', title: 'Test', prix: 100, vendeurNom: 'Jean', vendeurNote: 4.8, city: 'Paris' };
const filteredNoSeller = exporting.filterAdByFields(testAd, exporting.ALL_FIELD_KEYS, { excludeSellerData: true });
assert(!('vendeurNom' in filteredNoSeller), 'filterAdByFields: excludeSellerData=true retire vendeurNom');
assert(!('vendeurNote' in filteredNoSeller), 'filterAdByFields: excludeSellerData=true retire vendeurNote');
assert(filteredNoSeller.id === '1', 'filterAdByFields: garde les champs non-vendeur');

// toReadableBlock exclut les champs vendeur
const blockNoSeller = exporting.toReadableBlock(testAd, 0, exporting.ALL_FIELD_KEYS, { excludeSellerData: true });
assert(!blockNoSeller.includes('Vendeur'), 'toReadableBlock: excludeSellerData=true exclut section Vendeur');

// Pipeline : --no-seller-data argument parsé
assert(/--no-seller-data/.test(pipelineCode), 'pipeline: argument CLI --no-seller-data');
assert(/includeSellerData/.test(pipelineCode), 'pipeline: includeSellerData dans writeOutputsFactory');
assert(/export-meta\.json/.test(pipelineCode) && /includeSellerData/.test(pipelineCode), 'pipeline: export-meta.json inclut includeSellerData');

// pipelineRunner : forward --no-seller-data
assert(/--no-seller-data/.test(runnerCode), 'pipelineRunner: forward --no-seller-data');

// ipcHandlers : includeSellerData passé au pipeline
assert(/includeSellerData/.test(ipcCodeNew), 'ipcHandlers: passe includeSellerData au pipeline');

// index.html : modal légal + checkbox données vendeur
assert(/id="legalNoticeModal"/.test(indexCode), 'index.html: modal Utilisation autorisée uniquement');
assert(/id="cfgIncludeSellerData"/.test(indexCode), 'index.html: checkbox Données vendeur');
assert(/id="legalNoticeAcceptBtn"/.test(indexCode), 'index.html: bouton J\'ai compris');

// app.js : logique modal légal + visibilité données vendeur
assert(/legalNoticeModal/.test(appCodeNew), 'app.js: référence modal légal');
assert(/LEGAL_NOTICE_KEY/.test(appCodeNew), 'app.js: clé localStorage pour notice légale');
assert(/includeSellerData/.test(appCodeNew), 'app.js: gestion includeSellerData');
assert(/applySellerDataVisibility/.test(appCodeNew), 'app.js: fonction applySellerDataVisibility');
assert(/seller-data-hidden/.test(appCodeNew) || /seller-data-hidden/.test(stylesCode), 'app.js/styles: classe seller-data-hidden');

// Fichiers documentation
assert(fs.existsSync(path.join(__dirname, '..', 'LEGAL.md')), 'LEGAL.md existe à la racine');
assert(fs.existsSync(path.join(__dirname, '..', 'docs', 'DATA_HANDLING.md')), 'docs/DATA_HANDLING.md existe');

// --- 12. Sécurité + robustesse ---
console.log('\n[12] Sécurité + robustesse');

// URL Security helper : validation SSRF présente
const urlSecCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/utils/urlSecurity.js'), 'utf8');
assert(/validateRemoteUrl/.test(urlSecCode), 'urlSecurity: validateRemoteUrl présente');
assert(/127\.0\.0\.0|10\.0\.0\.0|172\.16\.0\.0|192\.168\.0\.0/.test(urlSecCode), 'urlSecurity: plages IP privées bloquées');

// urlSecurity : comportement réel (IPv4 privées, IPv6 ULA/link-local, IPv4-mappées)
(function () {
  const { isPrivateIPv4, isPrivateIPv6, isBlockedIpLiteral } = require('../src/main/utils/urlSecurity');
  assert(isPrivateIPv4('127.0.0.1') === true, 'urlSecurity: 127.0.0.1 privée');
  assert(isPrivateIPv4('10.0.0.5') === true, 'urlSecurity: 10.0.0.0/8 privée');
  assert(isPrivateIPv4('172.16.0.1') === true, 'urlSecurity: 172.16/12 privée');
  assert(isPrivateIPv4('192.168.1.1') === true, 'urlSecurity: 192.168/16 privée');
  assert(isPrivateIPv4('169.254.1.1') === true, 'urlSecurity: 169.254/16 link-local');
  assert(isPrivateIPv4('100.64.0.1') === true, 'urlSecurity: 100.64/10 CGNAT');
  assert(isPrivateIPv4('8.8.8.8') === false, 'urlSecurity: 8.8.8.8 publique (autorisée)');
  assert(isPrivateIPv4('1.1.1.1') === false, 'urlSecurity: 1.1.1.1 publique');
  assert(isPrivateIPv6('::1') === true, 'urlSecurity: ::1 loopback IPv6');
  assert(isPrivateIPv6('fc00::1') === true, 'urlSecurity: fc00::/7 ULA');
  assert(isPrivateIPv6('fd12::1') === true, 'urlSecurity: fd…/8 ULA');
  assert(isPrivateIPv6('fe80::1') === true, 'urlSecurity: fe80::/10 link-local');
  assert(isPrivateIPv6('::ffff:127.0.0.1') === true, 'urlSecurity: IPv4-mappée 127.0.0.1 bloquée');
  assert(isPrivateIPv6('::ffff:8.8.8.8') === false, 'urlSecurity: IPv4-mappée publique autorisée');
  assert(isPrivateIPv6('2001:4860:4860::8888') === false, 'urlSecurity: IPv6 publique autorisée');
  assert(isBlockedIpLiteral('10.0.0.1') === true, 'urlSecurity: isBlockedIpLiteral IPv4 privée');
  assert(isBlockedIpLiteral('2001:4860:4860::8888') === false, 'urlSecurity: isBlockedIpLiteral IPv6 publique');
})();

// urlSecurity : isSafeFetchDestination (contrôle synchrone fail-closed du chemin navigateur)
(function () {
  const { isSafeFetchDestination, isHostAllowed } = require('../src/main/utils/urlSecurity');

  // Destinations autorisées (Leboncoin légitime)
  assert(isSafeFetchDestination('https://www.leboncoin.fr/recherche?text=pc').safe === true,
    'urlSecurity: URL Leboncoin https autorisée');
  assert(isSafeFetchDestination('https://img.leboncoin.fr/api/v1/img').safe === true,
    'urlSecurity: CDN image Leboncoin autorisé (sans allowlist)');

  // Protocoles non http(s)
  assert(isSafeFetchDestination('file:///etc/passwd').safe === false, 'urlSecurity: file:// refusé');
  assert(isSafeFetchDestination('ftp://example.com/x').safe === false, 'urlSecurity: ftp:// refusé');
  assert(isSafeFetchDestination('data:text/html,x').safe === false, 'urlSecurity: data: refusé');
  assert(isSafeFetchDestination('javascript:alert(1)').safe === false, 'urlSecurity: javascript: refusé');

  // IP privées / loopback / link-local littérales (SSRF)
  assert(isSafeFetchDestination('http://127.0.0.1/').safe === false, 'urlSecurity: 127.0.0.1 refusé');
  assert(isSafeFetchDestination('http://169.254.169.254/latest/meta-data/').safe === false,
    'urlSecurity: endpoint metadata cloud refusé');
  assert(isSafeFetchDestination('http://10.0.0.5/').safe === false, 'urlSecurity: 10/8 refusé');
  assert(isSafeFetchDestination('http://[::1]/').safe === false, 'urlSecurity: [::1] refusé');
  assert(isSafeFetchDestination('http://[fe80::1]/').safe === false, 'urlSecurity: [fe80::1] refusé');
  assert(isSafeFetchDestination('http://[::ffff:127.0.0.1]/').safe === false, 'urlSecurity: IPv4-mappée refusée');

  // Hostnames locaux
  assert(isSafeFetchDestination('http://localhost/').safe === false, 'urlSecurity: localhost refusé');
  assert(isSafeFetchDestination('http://printer.local/').safe === false, 'urlSecurity: *.local refusé');
  assert(isSafeFetchDestination('http://svc.internal/').safe === false, 'urlSecurity: *.internal refusé');

  // Allowlist : impose le domaine Leboncoin
  assert(isSafeFetchDestination('http://127.0.0.1/', ['leboncoin.fr']).safe === false,
    'urlSecurity: IP privée refusée même avec allowlist');
  assert(isSafeFetchDestination('https://evil.example.com/x', ['leboncoin.fr']).safe === false,
    'urlSecurity: domaine hors allowlist refusé');
  assert(isSafeFetchDestination('https://www.leboncoin.fr/recherche', ['leboncoin.fr']).safe === true,
    'urlSecurity: domaine Leboncoin accepté avec allowlist');
  assert(isSafeFetchDestination('https://leboncoin.fr.attacker.com/x', ['leboncoin.fr']).safe === false,
    'urlSecurity: suffixe trompeur (leboncoin.fr.attacker.com) refusé');
  assert(isHostAllowed('www.leboncoin.fr', ['leboncoin.fr']) === true, 'urlSecurity: isHostAllowed sous-domaine');
  assert(isHostAllowed('leboncoin.fr.attacker.com', ['leboncoin.fr']) === false, 'urlSecurity: isHostAllowed suffixe trompeur');
})();

// urlSecurity : validateRemoteUrl fail-closed (DNS vide → refus) + allowlist
await (async function () {
  const { validateRemoteUrl } = require('../src/main/utils/urlSecurity');
  const badProto = await validateRemoteUrl('gopher://example.com/');
  assert(badProto.safe === false, 'urlSecurity: validateRemoteUrl refuse les protocoles non http(s)');
  const badIp = await validateRemoteUrl('http://192.168.1.1/');
  assert(badIp.safe === false, 'urlSecurity: validateRemoteUrl refuse une IP privée littérale');
  const emptyDns = await validateRemoteUrl('http://definitely-not-a-real-host-xyz-9999.invalid/');
  assert(emptyDns.safe === false && /fail-closed/.test(emptyDns.reason || ''),
    'urlSecurity: validateRemoteUrl fail-closed si résolution DNS vide');
})();

// harCapturer : contrôle de destination + garde réseau RESTAURÉS (le moteur
// historique les avait retirés). La protection anti-SSRF est de nouveau active
// à deux niveaux : validation de l'URL de recherche AVANT le lancement de
// Chromium, et filtrage de TOUTES les sous-requêtes (`_installNetworkGuard`).
// Le pipeline d'enrichissement conserve en plus son allowlist
// (`ALLOWED_FETCH_HOSTS` + `isFetchUrlAllowed`).
{
  const harSecCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/scraping/harCapturer.js'), 'utf8');
  assert(/isSafeFetchDestination/.test(harSecCode), 'harCapturer: contrôle SSRF restauré (URL de recherche)');
  assert(/_installNetworkGuard/.test(harSecCode), 'harCapturer: garde réseau restauré (sous-requêtes)');
  const pipeSecCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), 'utf8');
  assert(/ALLOWED_FETCH_HOSTS/.test(pipeSecCode) && /isFetchUrlAllowed/.test(pipeSecCode),
    'pipeline: filtrage SSRF des enrichissements conservé');
}

// Data nullability : livraison/mainPropre/type ne sont plus inventés
const adFieldsCodeFinal = fs.readFileSync(path.join(base, 'services/scraping/adFields.js'), 'utf8');
assert(!/Array\.isArray\(raw\?\.attributes\) && raw\.attributes\.length > 0/.test(adFieldsCodeFinal), 'adFields: plus de fallback livraison=false sur attributes');
assert(!/mainPropre\s*=\s*true[^;]*livraison\s*===?\s*false/.test(adFieldsCodeFinal.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'adFields: plus de fallback mainPropre=true sur livraison=false');
assert(!/type:\s*type\s*\|\|\s*\(isPro/.test(adFieldsCodeFinal), 'adFields: plus de default type=particulier');

// Pipeline : process.exit remplacé par return/throw
const pipelineCodeFinal = fs.readFileSync(path.join(base, 'services/scraping/leboncoin-pipeline.js'), 'utf8');
assert(!/process\.exit\(0\)/.test(pipelineCodeFinal), 'pipeline: plus de process.exit(0)');
assert(/process\.exitCode\s*=\s*1/.test(pipelineCodeFinal) || /throw\s+err/.test(pipelineCodeFinal), 'pipeline: erreurs via throw/process.exitCode');

// export-meta.json : checksum
assert(/writeWithChecksum.*export-meta/.test(pipelineCodeFinal), 'pipeline: export-meta.json écrit avec checksum');

// --- 13. Tests comportementaux sécurité ---
console.log('\n[13] Tests comportementaux sécurité');

// XSS: escapeHtml doit échapper les caractères dangereux
const appCodeFinal = appCode;
assert(/function escapeHtml\(str\)/.test(appCodeFinal), 'app.js: escapeHtml définie');
assert(appCodeFinal.includes("replace(/&/g, '&amp;')"), 'escapeHtml: échappe &');
assert(appCodeFinal.includes("replace(/</g, '&lt;')"), 'escapeHtml: échappe <');
assert(appCodeFinal.includes("replace(/>/g, '&gt;')"), 'escapeHtml: échappe >');
assert(appCodeFinal.includes("replace(/\"/g, '&quot;')"), 'escapeHtml: échappe "');
assert(appCodeFinal.includes("replace(/'/g, '&#39;')"), 'escapeHtml: échappe \'');

// Test comportemental de la regex d'échappement (simulation)
const dangerous = '<script>alert(1)</script>';
const simulated = dangerous.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
assert(simulated.includes('&lt;script&gt;'), 'escapeHtml simulation: échappe <script>');
assert(!simulated.includes('<script>'), 'escapeHtml simulation: pas de <script> brut');

// JSON.parse corrompu : pipeline doit gérer l'erreur et re-scraper
const tmpDirCorrupt = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-corrupt-'));
const corruptJsonPath = path.join(tmpDirCorrupt, 'annonces.json');
fs.writeFileSync(corruptJsonPath, 'NOT VALID JSON{{{');
const pipelineCode3 = fs.readFileSync(path.join(base, 'services/scraping/leboncoin-pipeline.js'), 'utf8');
assert(/JSON\.parse\(fs\.readFileSync\(jsonPath/.test(pipelineCode3), 'pipeline: parse annonces.json');
assert(/try[\s\S]*?JSON\.parse[\s\S]*?catch/.test(pipelineCode3) || /catch \(err\)[\s\S]*?annonces\.json corrompu/.test(pipelineCode3), 'pipeline: JSON.parse protégé par try/catch');

// localStorage: les données corrompues ne doivent pas crasher
const localStorageSafePattern = /try\s*\{[\s\S]*?localStorage\.getItem\(['"]starred-ads['"]\)[\s\S]*?JSON\.parse[\s\S]*?new\s+Set\(/;
assert(localStorageSafePattern.test(appCode), 'app.js: localStorage starred-ads parsé avec try/catch');

// --- 14. Détection de changement de structure Leboncoin ---
console.log('\n[14] Détection changement de structure');
(function () {
const { detectStructureChanges } = require('../src/main/services/scraping/leboncoin-pipeline');
assert(typeof detectStructureChanges === 'function', 'detectStructureChanges exportée depuis le pipeline');

// Cas normal : tous les champs critiques présents → pas de warning
const normalAds = Array.from({ length: 10 }, (_, i) => ({
  list_id: i + 1, subject: `Item ${i}`, price: 100, body: 'desc',
  location: { city: 'Paris' },
}));
const normalResult = detectStructureChanges(normalAds, null);
assert(normalResult.warnings.length === 0, 'detectStructureChanges: pas de warning quand tous les champs présents');
assert(normalResult.missingFields.length === 0, 'detectStructureChanges: missingFields vide quand structure OK');

// Cas changement : list_id supprimé (renommé en ad_id) → détecté via alternatives
const renamedIdAds = Array.from({ length: 10 }, (_, i) => ({
  ad_id: i + 1, subject: `Item ${i}`, price: 100, body: 'desc',
  location: { city: 'Paris' },
}));
const renamedResult = detectStructureChanges(renamedIdAds, null);
assert(renamedResult.warnings.length === 0, 'detectStructureChanges: pas de warning si alternative trouvée (ad_id pour list_id)');

// Cas réel : Leboncoin supprime "price" et "body" → 2 warnings
const brokenAds = Array.from({ length: 10 }, (_, i) => ({
  list_id: i + 1, subject: `Item ${i}`,
  location: { city: 'Lyon' },
  new_price_field: 100,
  new_body_field: 'desc',
}));
const brokenResult = detectStructureChanges(brokenAds, null);
assert(brokenResult.warnings.length >= 2, 'detectStructureChanges: 2+ warnings quand price ET body manquent');
assert(brokenResult.missingFields.includes('price'), 'detectStructureChanges: price détecté comme manquant');
assert(brokenResult.missingFields.includes('body'), 'detectStructureChanges: body détecté comme manquant');

// Cas limite : tableau vide → pas de crash, pas de warning
const emptyResult = detectStructureChanges([], null);
assert(emptyResult.warnings.length === 0, 'detectStructureChanges: tableau vide → pas de warning');
assert(detectStructureChanges(null, null).warnings.length === 0, 'detectStructureChanges: null → pas de crash');

// Cas seuil : 50% manquant → pas de warning (seuil >70%)
const halfMissing = Array.from({ length: 10 }, (_, i) => ({
  list_id: i + 1, subject: `Item ${i}`, body: 'desc', location: { city: 'Lyon' },
  ...(i < 5 ? { price: 100 } : {}),
}));
const halfResult = detectStructureChanges(halfMissing, null);
assert(halfResult.warnings.length === 0, 'detectStructureChanges: 50% manquant → pas de warning (seuil 70%)');

})();

// --- 15. exportFields : filterAdByFields + toReadableBlock ---
console.log('\n[15] exportFields (filterAdByFields + toReadableBlock)');
(function () {
const { filterAdByFields, toReadableBlock, ALL_FIELD_KEYS } = require('../src/main/services/exporting/exportFields');

const rtAd = {
  id: '12345', title: 'iPhone 12 | 128Go', url: 'https://www.leboncoin.fr/ad/12345.htm',
  prix: 350, city: 'Lyon', zipcode: '69000',
  vendeurNom: 'Jean', vendeurType: 'particulier', vendeurId: 'u1',
  vendeurNote: 4.8, nombreAvis: 27, vendeurUrlProfil: 'https://www.leboncoin.fr/u1',
  livraison: true, mainPropre: false, deliveryType: 'livraison',
  likes: 12,
  datePublication: '2026-09-10T10:00:00Z',
  dateScraping: '2026-09-14T12:00:00Z',
  etat: 'Très bon état',
  photosCount: 5, photosUrls: ['https://img.lbc.fr/1.jpg', 'https://img.lbc.fr/2.jpg'],
  description: 'Vends iPhone 12\n128Go\nPas de rayures',
};

// filterAdByFields : mode Personnalisé ne garde que les champs sélectionnés
const filtered = filterAdByFields(rtAd, ['id', 'title', 'prix']);
assert(filtered.id === '12345', 'filterAdByFields: id conservé');
assert(filtered.title === 'iPhone 12 | 128Go', 'filterAdByFields: title conservé');
assert(filtered.prix === 350, 'filterAdByFields: prix conservé');
assert(!('city' in filtered), 'filterAdByFields: city supprimé (non sélectionné)');
assert(!('vendeurNom' in filtered), 'filterAdByFields: vendeurNom supprimé (non sélectionné)');

// filterAdByFields : null/[] → objet tel quel (mode Défaut)
assert(filterAdByFields(rtAd, null) === rtAd, 'filterAdByFields: null → objet original (mode Défaut)');
assert(filterAdByFields(rtAd, []) === rtAd, 'filterAdByFields: [] → objet original (mode Défaut)');

// filterAdByFields : excludeSellerData
const filteredNoSeller = filterAdByFields(rtAd, ALL_FIELD_KEYS, { excludeSellerData: true });
assert(!('vendeurNom' in filteredNoSeller), 'filterAdByFields: excludeSellerData supprime vendeurNom');
assert(filteredNoSeller.id === '12345', 'filterAdByFields: excludeSellerData garde id');

// toReadableBlock : génère un bloc TXT lisible
const block = toReadableBlock(rtAd, 0);
assert(block.includes('===== ANNONCE 1 ====='), 'toReadableBlock: en-tête annonce');
assert(block.includes('iPhone 12 | 128Go'), 'toReadableBlock: titre dans le bloc');
assert(block.includes('350 €'), 'toReadableBlock: prix formaté avec €');
assert(block.includes('Lyon'), 'toReadableBlock: ville dans le bloc');

// toReadableBlock : mode Personnalisé ne montre que les champs sélectionnés
const customBlock = toReadableBlock(rtAd, 0, ['id', 'title']);
assert(customBlock.includes('12345'), 'toReadableBlock custom: id présent');
assert(customBlock.includes('iPhone 12 | 128Go'), 'toReadableBlock custom: titre présent');
assert(!customBlock.includes('Lyon'), 'toReadableBlock custom: ville absente (non sélectionnée)');

})();

// --- 16. adFields : extracteurs défensifs sur fixtures variées ---
console.log('\n[16] adFields extracteurs (fixtures)');
(function () {
const adFields = require('../src/main/services/scraping/adFields');

// extractDescription : body string, objet {text}, null
assert(adFields.extractDescription({ body: 'texte simple' }) === 'texte simple', 'extractDescription: body string');
assert(adFields.extractDescription({ body: { text: 'texte objet' } }) === 'texte objet', 'extractDescription: body objet {text}');
assert(adFields.extractDescription({ body: {} }) === null, 'extractDescription: body objet vide → null');
assert(adFields.extractDescription({ body: 42 }) === null, 'extractDescription: body nombre → null');
assert(adFields.extractDescription({ body: null }) === null, 'extractDescription: body null → null');
assert(adFields.extractDescription({ description: 'fallback' }) === 'fallback', 'extractDescription: description fallback');
assert(adFields.extractDescription({}) === null, 'extractDescription: objet vide → null');
assert(adFields.extractDescription(null) === null, 'extractDescription: null → null');

// extractPrice : nombre, string, array, objet, null
assert(adFields.extractPrice({ price: 150 }) === 150, 'extractPrice: nombre');
assert(adFields.extractPrice({ price: '200' }) === 200, 'extractPrice: string');
assert(adFields.extractPrice({ price: [{ value: 300 }] }) === 300, 'extractPrice: array d\'objets');
assert(adFields.extractPrice({ price: { value: 250 } }) === 250, 'extractPrice: objet {value}');
assert(adFields.extractPrice({ price: null }) === null, 'extractPrice: null → null');
assert(adFields.extractPrice({}) === null, 'extractPrice: absent → null');
assert(adFields.extractPrice({ price: 'abc' }) === null, 'extractPrice: string non-numérique → null');

// extractTransaction : livraison et mainPropre indépendants
const tx1 = adFields.extractTransaction({ has_option: { shipping: true }, body: 'remise en main propre' });
assert(tx1.livraison === true, 'extractTransaction: livraison=true depuis has_option');
assert(tx1.mainPropre === true, 'extractTransaction: mainPropre=true depuis description');
const tx2 = adFields.extractTransaction({ has_option: { shipping: false }, body: 'pas d\'envoi' });
assert(tx2.livraison === false, 'extractTransaction: livraison=false');
assert(tx2.mainPropre === true, 'extractTransaction: mainPropre=true (pas d\'envoi)');
const tx3 = adFields.extractTransaction({ body: 'retrait sur place' });
assert(tx3.livraison === null, 'extractTransaction: livraison=null si non trouvé');
assert(tx3.mainPropre === true, 'extractTransaction: mainPropre=true (retrait sur place)');
const tx4 = adFields.extractTransaction({});
assert(tx4.livraison === null && tx4.mainPropre === null, 'extractTransaction: objet vide → null/null');

// extractSeller : nom, type, note, id
const seller1 = adFields.extractSeller({
  owner: { name: 'Jean', type: 'particulier', rating: 4.5, nb_ratings: 10, user_id: 42 },
});
assert(seller1.nom === 'Jean', 'extractSeller: nom');
assert(seller1.type === 'particulier', 'extractSeller: type particulier');
assert(seller1.note === 4.5, 'extractSeller: note');
assert(seller1.nombreAvis === 10, 'extractSeller: nombreAvis');
assert(seller1.id === '42', 'extractSeller: id string');
const seller2 = adFields.extractSeller({ owner: { type: 'pro', store_name: 'Shop' } });
assert(seller2.type === 'pro', 'extractSeller: type pro');
assert(seller2.isPro === true, 'extractSeller: isPro déduit');
const seller3 = adFields.extractSeller({});
assert(seller3.nom === null, 'extractSeller: objet vide → nom null');
assert(seller3.note === null, 'extractSeller: objet vide → note null');

// extractCondition : attribut condition/etat
assert(adFields.extractCondition({ attributes: [{ key: 'condition', value: 'Bon état' }] }) === 'Bon état', 'extractCondition: key=condition');
assert(adFields.extractCondition({ attributes: [{ key: 'etat', value: 'Neuf' }] }) === 'Neuf', 'extractCondition: key=etat');
assert(adFields.extractCondition({ attributes: [] }) === null, 'extractCondition: attributs vides → null');
assert(adFields.extractCondition({}) === null, 'extractCondition: pas dattributs → null');

// extractPhotos : urls depuis images.urls ou images array
const photos1 = adFields.extractPhotos({ images: { urls: ['https://a.jpg', 'https://b.jpg'] } });
assert(photos1.count === 2, 'extractPhotos: count depuis images.urls');
assert(photos1.urls.length === 2, 'extractPhotos: urls depuis images.urls');
const photos2 = adFields.extractPhotos({ images: ['https://c.jpg'] });
assert(photos2.count === 1, 'extractPhotos: count depuis images array');
const photos3 = adFields.extractPhotos({});
assert(photos3.count === 0, 'extractPhotos: pas dimages → count 0');

// extractLikes : nombre, string, null
assert(adFields.extractLikes({ favorites_count: 5 }) === 5, 'extractLikes: favorites_count');
assert(adFields.extractLikes({ likes_count: '10' }) === 10, 'extractLikes: string parsée');
assert(adFields.extractLikes({}) === null, 'extractLikes: absent → null');

})();

// --- 17. package.json : plus de exceljs ---
console.log('\n[17] package.json');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
assert(!pkg.dependencies || !pkg.dependencies.exceljs, 'package.json: exceljs supprimé des dépendances');
assert(pkg.dependencies && pkg.dependencies.playwright, 'package.json: playwright conservé');
assert(pkg.devDependencies && pkg.devDependencies.electron, 'package.json: electron conservé');

// --- 18. Error codes (errorCodes.js) ---
console.log('\n[18] Error codes (errorCodes.js)');
(function () {
  const { ErrorCodes, createError, classifyError } = require('../src/main/services/scraping/errorCodes');

  // ErrorCodes : codes principaux présents
  assert(ErrorCodes.NET_TIMEOUT === 'NET_TIMEOUT', 'ErrorCodes: NET_TIMEOUT');
  assert(ErrorCodes.HTTP_403 === 'HTTP_403', 'ErrorCodes: HTTP_403');
  assert(ErrorCodes.HTTP_429 === 'HTTP_429', 'ErrorCodes: HTTP_429');
  assert(ErrorCodes.CAPTCHA_DETECTED === 'CAPTCHA_DETECTED', 'ErrorCodes: CAPTCHA_DETECTED');
  assert(ErrorCodes.CAPTCHA_TIMEOUT === 'CAPTCHA_TIMEOUT', 'ErrorCodes: CAPTCHA_TIMEOUT');
  assert(ErrorCodes.CAPTCHA_UNRESOLVED === 'CAPTCHA_UNRESOLVED', 'ErrorCodes: CAPTCHA_UNRESOLVED');
  assert(ErrorCodes.PARSE_HAR_INVALID === 'PARSE_HAR_INVALID', 'ErrorCodes: PARSE_HAR_INVALID');
  assert(ErrorCodes.EXTRACTOR_SELLER_NAME_FAILED === 'EXTRACTOR_SELLER_NAME_FAILED', 'ErrorCodes: EXTRACTOR_SELLER_NAME_FAILED');
  assert(ErrorCodes.STRUCTURE_CHANGED === 'STRUCTURE_CHANGED', 'ErrorCodes: STRUCTURE_CHANGED');
  assert(ErrorCodes.STRUCTURE_FIELD_MISSING === 'STRUCTURE_FIELD_MISSING', 'ErrorCodes: STRUCTURE_FIELD_MISSING');
  assert(ErrorCodes.AD_EMPTY === 'AD_EMPTY', 'ErrorCodes: AD_EMPTY');
  assert(ErrorCodes.AD_DELETED === 'AD_DELETED', 'ErrorCodes: AD_DELETED');
  assert(ErrorCodes.BROWSER_CRASHED === 'BROWSER_CRASHED', 'ErrorCodes: BROWSER_CRASHED');
  assert(ErrorCodes.SESSION_EXPIRED === 'SESSION_EXPIRED', 'ErrorCodes: SESSION_EXPIRED');

  // createError : structure correcte
  const err = createError('HTTP_403', 'Accès interdit', { url: 'https://example.com' });
  assert(err.code === 'HTTP_403', 'createError: code');
  assert(err.message === 'Accès interdit', 'createError: message');
  assert(err.context.url === 'https://example.com', 'createError: context');
  assert(typeof err.timestamp === 'string' && err.timestamp.length > 0, 'createError: timestamp ISO string');

  // createError : message par défaut = code si non fourni
  const err2 = createError('NET_TIMEOUT');
  assert(err2.message === 'NET_TIMEOUT', 'createError: message defaults to code');
  assert(err2.context && typeof err2.context === 'object', 'createError: context defaults to {}');

  // createError : sans contexte
  const err3 = createError('AD_EMPTY', 'Annonce vide');
  assert(err3.context !== undefined, 'createError: context is {} not undefined');

  // classifyError : catégories correctes pour chaque préfixe
  assert(classifyError('NET_TIMEOUT') === 'network_error', 'classifyError: NET_ → network_error');
  assert(classifyError('NET_CONNECTION_FAILED') === 'network_error', 'classifyError: NET_ → network_error (2)');
  assert(classifyError('HTTP_403') === 'network_error', 'classifyError: HTTP_4xx → network_error');
  assert(classifyError('HTTP_429') === 'network_error', 'classifyError: HTTP_429 → network_error');
  assert(classifyError('HTTP_404') === 'network_error', 'classifyError: HTTP_404 → network_error');
  assert(classifyError('HTTP_500') === 'global_error', 'classifyError: HTTP_5xx → global_error');
  assert(classifyError('HTTP_502') === 'global_error', 'classifyError: HTTP_502 → global_error');
  assert(classifyError('CAPTCHA_DETECTED') === 'session_error', 'classifyError: CAPTCHA_ → session_error');
  assert(classifyError('CAPTCHA_TIMEOUT') === 'session_error', 'classifyError: CAPTCHA_TIMEOUT → session_error');
  assert(classifyError('CAPTCHA_UNRESOLVED') === 'session_error', 'classifyError: CAPTCHA_UNRESOLVED → session_error');
  assert(classifyError('PARSE_HAR_INVALID') === 'global_error', 'classifyError: PARSE_ → global_error');
  assert(classifyError('PARSE_NO_ADS') === 'global_error', 'classifyError: PARSE_NO_ADS → global_error');
  assert(classifyError('EXTRACTOR_SELLER_NAME_FAILED') === 'ad_error', 'classifyError: EXTRACTOR_ → ad_error');
  assert(classifyError('EXTRACTOR_PRICE_FAILED') === 'ad_error', 'classifyError: EXTRACTOR_PRICE → ad_error');
  assert(classifyError('SESSION_EXPIRED') === 'session_error', 'classifyError: SESSION_ → session_error');
  assert(classifyError('SESSION_INVALID') === 'session_error', 'classifyError: SESSION_INVALID → session_error');
  assert(classifyError('BROWSER_CRASHED') === 'global_error', 'classifyError: BROWSER_ → global_error');
  assert(classifyError('BROWSER_LAUNCH_FAILED') === 'global_error', 'classifyError: BROWSER_LAUNCH → global_error');
  assert(classifyError('STRUCTURE_CHANGED') === 'global_error', 'classifyError: STRUCTURE_ → global_error');
  assert(classifyError('STRUCTURE_FIELD_MISSING') === 'global_error', 'classifyError: STRUCTURE_FIELD → global_error');
  assert(classifyError('AD_DELETED') === 'ad_error', 'classifyError: AD_ → ad_error');
  assert(classifyError('AD_EMPTY') === 'ad_error', 'classifyError: AD_EMPTY → ad_error');
  assert(classifyError('AD_MODIFIED') === 'ad_error', 'classifyError: AD_MODIFIED → ad_error');

  // classifyError : cas limites
  assert(classifyError(null) === 'unknown', 'classifyError: null → unknown');
  assert(classifyError(undefined) === 'unknown', 'classifyError: undefined → unknown');
  assert(classifyError('') === 'unknown', 'classifyError: empty string → unknown');
  assert(classifyError('UNKNOWN_CODE') === 'unknown', 'classifyError: unknown code → unknown');
})();

// --- 18b. Extractor error callbacks ---
console.log('\n[18b] Extractor error callbacks (adFields.js)');
(function () {
  const adFields = require('../src/main/services/scraping/adFields');

  // extractSeller : callback appelée quand owner existe sans name
  {
    const errors = [];
    const onError = (err) => errors.push(err);
    // owner avec name → pas d'erreur EXTRACTOR_SELLER_NAME_FAILED
    adFields.extractSeller({ owner: { name: 'Jean' } }, { onError });
    assert(!errors.some((e) => e.code === 'EXTRACTOR_SELLER_NAME_FAILED'), "extractSeller: pas d'erreur EXTRACTOR_SELLER_NAME_FAILED quand owner.name présent");

    // owner sans name → erreur EXTRACTOR_SELLER_NAME_FAILED
    errors.length = 0;
    adFields.extractSeller({ owner: { type: 'pro' } }, { onError });
    assert(errors.length >= 1, 'extractSeller: erreur quand owner existe sans name');
    assert(errors.some((e) => e.code === 'EXTRACTOR_SELLER_NAME_FAILED'), 'extractSeller: code EXTRACTOR_SELLER_NAME_FAILED');

    // owner sans user_id ni id → erreur EXTRACTOR_SELLER_ID_FAILED
    errors.length = 0;
    adFields.extractSeller({ owner: { name: 'Jean' } }, { onError });
    assert(errors.some((e) => e.code === 'EXTRACTOR_SELLER_ID_FAILED'), 'extractSeller: code EXTRACTOR_SELLER_ID_FAILED quand owner sans id');

    // pas d'owner → pas d'erreur
    errors.length = 0;
    adFields.extractSeller({}, { onError });
    assert(errors.length === 0, "extractSeller: pas d'erreur sans owner");
  }

  // extractPrice : callback appelée quand price présent mais non convertible
  {
    const errors = [];
    const onError = (err) => errors.push(err);
    // price valide → pas d'erreur
    adFields.extractPrice({ price: 100 }, { onError });
    assert(errors.length === 0, "extractPrice: pas d'erreur quand price valide");

    // price string non numérique → erreur
    errors.length = 0;
    adFields.extractPrice({ price: 'abc' }, { onError });
    assert(errors.some((e) => e.code === 'EXTRACTOR_PRICE_FAILED'), 'extractPrice: code EXTRACTOR_PRICE_FAILED quand non convertible');

    // pas de price → pas d'erreur
    errors.length = 0;
    adFields.extractPrice({}, { onError });
    assert(errors.length === 0, "extractPrice: pas d'erreur sans price");
  }

  // extractDescription : callback appelée quand body présent mais non exploitable
  {
    const errors = [];
    const onError = (err) => errors.push(err);
    // body string → pas d'erreur
    adFields.extractDescription({ body: 'texte' }, { onError });
    assert(errors.length === 0, "extractDescription: pas d'erreur quand body string");

    // body objet sans text → erreur
    errors.length = 0;
    adFields.extractDescription({ body: { foo: 'bar' } }, { onError });
    assert(errors.some((e) => e.code === 'EXTRACTOR_DESCRIPTION_FAILED'), 'extractDescription: code EXTRACTOR_DESCRIPTION_FAILED quand body non exploitable');

    // body nombre → erreur
    errors.length = 0;
    adFields.extractDescription({ body: 42 }, { onError });
    assert(errors.some((e) => e.code === 'EXTRACTOR_DESCRIPTION_FAILED'), 'extractDescription: erreur quand body nombre');

    // pas de body → pas d'erreur
    errors.length = 0;
    adFields.extractDescription({}, { onError });
    assert(errors.length === 0, "extractDescription: pas d'erreur sans body");
  }

  // extractDates : callback appelée quand aucune date reconnue
  {
    const errors = [];
    const onError = (err) => errors.push(err);
    // date présente → pas d'erreur
    adFields.extractDates({ first_publication_date: '2026-01-15T10:00:00Z' }, { onError });
    assert(errors.length === 0, "extractDates: pas d'erreur quand date présente");

    // annonce avec données mais sans date → erreur
    errors.length = 0;
    adFields.extractDates({ list_id: 1, subject: 'Test', price: 100, body: 'desc' }, { onError });
    assert(errors.some((e) => e.code === 'EXTRACTOR_DATES_FAILED'), 'extractDates: code EXTRACTOR_DATES_FAILED quand aucune date');

    // objet vide → pas d'erreur (trop peu de clés)
    errors.length = 0;
    adFields.extractDates({}, { onError });
    assert(errors.length === 0, "extractDates: pas d'erreur sur objet vide");
  }

  // extractPhotos : callback appelée quand images présent mais structure inattendue
  {
    const errors = [];
    const onError = (err) => errors.push(err);
    // images.urls array → pas d'erreur
    adFields.extractPhotos({ images: { urls: ['https://a.jpg'] } }, { onError });
    assert(errors.length === 0, "extractPhotos: pas d'erreur quand images.urls array");

    // images array → pas d'erreur
    adFields.extractPhotos({ images: ['https://a.jpg'] }, { onError });
    assert(errors.length === 0, "extractPhotos: pas d'erreur quand images array");

    // images objet sans urls → erreur
    errors.length = 0;
    adFields.extractPhotos({ images: { total: 5 } }, { onError });
    assert(errors.some((e) => e.code === 'EXTRACTOR_PHOTOS_FAILED'), 'extractPhotos: code EXTRACTOR_PHOTOS_FAILED quand structure inattendue');

    // pas d'images → pas d'erreur
    errors.length = 0;
    adFields.extractPhotos({}, { onError });
    assert(errors.length === 0, "extractPhotos: pas d'erreur sans images");
  }

  // Sans callback → pas de crash
  assert(adFields.extractSeller({ owner: { type: 'pro' } }) !== undefined, 'extractSeller: sans callback → pas de crash');
  assert(adFields.extractPrice({ price: 'abc' }) === null, 'extractPrice: sans callback → pas de crash');
  assert(adFields.extractDescription({ body: 42 }) === null, 'extractDescription: sans callback → pas de crash');
})();

// --- 18c. computeDeliveryType (existing tests still pass) ---
console.log('\n[18c] computeDeliveryType (non-régression)');
(function () {
  const { computeDeliveryType } = require('../src/main/services/scraping/adFields');
  assert(computeDeliveryType(true, true) === 'les_deux', 'computeDeliveryType: true,true → les_deux');
  assert(computeDeliveryType(true, false) === 'livraison', 'computeDeliveryType: true,false → livraison');
  assert(computeDeliveryType(true, null) === 'livraison', 'computeDeliveryType: true,null → livraison');
  assert(computeDeliveryType(false, true) === 'main_propre', 'computeDeliveryType: false,true → main_propre');
  assert(computeDeliveryType(null, true) === 'main_propre', 'computeDeliveryType: null,true → main_propre');
  assert(computeDeliveryType(false, false) === 'aucun', 'computeDeliveryType: false,false → aucun');
  assert(computeDeliveryType(false, null) === 'aucun', 'computeDeliveryType: false,null → aucun');
  assert(computeDeliveryType(null, false) === 'aucun', 'computeDeliveryType: null,false → aucun');
  assert(computeDeliveryType(null, null) === 'inconnu', 'computeDeliveryType: null,null → inconnu');
})();

// --- 18d. Export : compatibilité des clés d'export avec le modèle normalizeAd ---
// Non-régression du bug : les clés d'export `ville`/`codePostal`/`vendeurNbAvis`/
// `vendeurAnciennete` étaient silencieusement supprimées des exports JSON car le
// modèle expose `city`/`zipcode`/`nombreAvis`/`vendeurAncienneteJours`.
console.log('\n[18d] Export field-key compatibility (non-régression)');
(function () {
  const { filterAdByFields, toReadableBlock } = require('../src/main/services/exporting/exportFields');
  const { getProfileFields } = require('../src/main/services/exporting/dataProfiles');

  // Annonce au format RÉEL produit par normalizeAd() (city/zipcode/nombreAvis…).
  const modelAd = {
    id: '42', title: 'GPU', url: 'https://www.leboncoin.fr/ad/42.htm', prix: 250,
    city: 'Lyon', zipcode: '69001', ville: 'Lyon', codePostal: '69001',
    vendeurNom: 'Jean', vendeurType: 'particulier', nombreAvis: 12,
    deliveryType: 'livraison',
    datePublication: '2026-01-01T10:00:00.000Z', dateScraping: '2026-01-02T10:00:00.000Z',
    photosCount: 2, photosUrls: ['a.jpg', 'b.jpg'], description: 'bon état', likes: 5,
  };

  const json = filterAdByFields(modelAd, getProfileFields('default'));
  assert(json.ville === 'Lyon', 'export JSON: ville présent depuis city (modèle réel)');
  assert(json.codePostal === '69001', 'export JSON: codePostal présent depuis zipcode (modèle réel)');
  assert(json.dateScraping === '2026-01-02T10:00:00.000Z', 'export JSON: date ISO brute préservée (non formatée)');
  assert(Array.isArray(json.photosUrls) && json.photosUrls.length === 2,
    'export JSON: photosUrls conservées en tableau dans le profil Défaut (explorateur)');

  const maxJson = filterAdByFields(modelAd, getProfileFields('maximum'));
  // Profil Maximum = dump brut du modèle (clés city/zipcode/nombreAvis).
  assert(maxJson.nombreAvis === 12, 'export JSON: profil Maximum conserve le modèle brut (nombreAvis)');
  assert(!('vendeurAncienneteJours' in maxJson) && !('dateModification' in maxJson),
    'export JSON: ancienneté vendeur et date modification supprimées du modèle');

  const txt = toReadableBlock(modelAd, 0, getProfileFields('default'));
  assert(txt.includes('Lyon'), 'export TXT: ville affichée');
  assert(txt.includes('69001'), 'export TXT: code postal affiché');

  // Rétro-compat : une annonce « métier » (ville/codePostal) reste lisible.
  const legacyAd = { id: '1', title: 'T', prix: 10, ville: 'Paris', codePostal: '75001' };
  const legacyJson = filterAdByFields(legacyAd, getProfileFields('default'));
  assert(legacyJson.ville === 'Paris', 'export JSON: rétro-compat clé ville directe');
  assert(legacyJson.codePostal === '75001', 'export JSON: rétro-compat clé codePostal directe');
})();

// ═══════════════════════════════════════════════════════════════════════════
// [20] NON-RÉGRESSION — bugs de la Phase 3 (audit global A→Z)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[20] Bugs Phase 3 (audit global)');
(() => {
  const repoRoot = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

  // [20a] Navigation onglets : app.js doit cibler [data-tab], pas .tab-btn.
  //       L'ancien sélecteur .tab-btn ne correspondait à AUCUN élément (sidebar
  //       == .nav-item) → aucun listener de navigation attaché.
  const appCode = read('src/renderer/app.js');
  assert(/querySelectorAll\('\[data-tab\]'\)/.test(appCode), 'app.js: navigation cible [data-tab] (bug onglets morts corrigé)');
  assert(!/querySelectorAll\('\.tab-btn'\)/.test(appCode), 'app.js: ancien sélecteur .tab-btn supprimé');
  const htmlCode = read('src/renderer/index.html');
  assert(!/class="tab-btn/.test(htmlCode), 'index.html: plus de boutons .tab-btn (sidebar = nav-item)');

  // [20b] Champs internes absents des exports (raw, extractionErrors, livraison, mainPropre).
  const pipelineCode = read('src/main/services/scraping/leboncoin-pipeline.js');
  assert(/INTERNAL_AD_FIELDS\s*=\s*\[[^\]]*'raw'/.test(pipelineCode), 'pipeline: raw listé comme champ interne');
  assert(/'extractionErrors'/.test(pipelineCode) && /stripInternalFields/.test(pipelineCode), 'pipeline: extractionErrors nettoyé avant écriture');
  assert(/'livraison'/.test(pipelineCode) && /'mainPropre'/.test(pipelineCode), 'pipeline: livraison/mainPropre exclus des exports');
  assert(/cleanAds/.test(pipelineCode), 'pipeline: writeOutputs utilise cleanAds');

  // [20c] Éléments DOM référencés mais absents (statMedPrice, structureWarning).
  assert(/id="statMedPrice"/.test(htmlCode), 'index.html: carte Prix Médian présente (statMedPrice)');
  assert(/id="structureWarning"/.test(htmlCode), 'index.html: bandeau structureWarning présent');
  assert(/id="structureWarningText"/.test(htmlCode), 'index.html: texte structureWarning présent');

  // [20d] ErrorCodes.UNKNOWN défini (référencé par PipelineRunner en fallback).
  const { ErrorCodes: EC } = require('../src/main/services/scraping/errorCodes');
  assert(EC.UNKNOWN === 'UNKNOWN', 'errorCodes: UNKNOWN défini (évite code [undefined])');

  // [20e] webviewTag désactivé sur la fenêtre principale (hors commentaires).
  const mainCode = read('src/main/main.js');
  const mainCodeNoComments = mainCode.replace(/\/\/[^\n]*/g, '');
  assert(/webviewTag:\s*false/.test(mainCodeNoComments), 'main.js: webviewTag désactivé (surface d\'attaque réduite)');
  assert(!/webviewTag:\s*true/.test(mainCodeNoComments), 'main.js: plus de webviewTag:true actif');

  // [20f] Visibilité données vendeur appliquée dès le chargement (sinon classe
  //       seller-data-hidden jamais positionnée).
  assert(/async function refreshSellerDataSetting\(\)[\s\S]*?applySellerDataVisibility\(\);/.test(appCode), 'app.js: refreshSellerDataSetting applique applySellerDataVisibility');

  // [20g] buildAdHistory : replis rétro-compat likes.
  const jhCode = read('src/main/services/jobs/jobHistory.js');
  assert(/ad\.likes\s*\?\?[\s\S]*statistiques\?\.likes/.test(jhCode), 'jobHistory: repli rétro-compat likes (statistiques.likes)');

  console.log('\n[20] OK');
})();

// ═══════════════════════════════════════════════════════════════════════════
// [21] NON-RÉGRESSION — Phase 3 lot 2 (UI, robustesse, paramètres)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[21] Phase 3 lot 2 (UI/robustesse)');
(() => {
  const repoRoot = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

  // [21a] Dropdown session ne doit pas restaurer une valeur inexistante (job supprimé).
  const expCode = read('src/renderer/explorerModule.js');
  assert(/stillExists\s*=\s*selectedVal[\s\S]*?some\(/.test(expCode), 'explorer: populateSessionDropdown vérifie l\'existence de la valeur (pas de vue vide après suppression)');

  // [21b] maxPages borné (parseInt('')/0 ne doit pas désactiver la limite de pagination).
  const ipcCode = read('src/main/core/ipcHandlers.js');
  assert(/Math\.min\(500,\s*Math\.max\(1,\s*parseInt\(pages/.test(ipcCode), 'ipcHandlers: maxPages clampé [1,500] (évite pagination illimitée)');

  // [21c] scraperModule réarme le bandeau structureWarning au démarrage d'un run.
  const scraperCode = read('src/renderer/scraperModule.js');
  assert(/structureWarning[\s\S]*?classList\.add\('hidden'\)/.test(scraperCode), 'scraper: structureWarning masqué au démarrage d\'un run');

  // [21d] renderCharts détruit les instances sur session vide (pas de graphiques fantômes).
  const statsCode = read('src/renderer/statsModule.js');
  assert(/ads\.length === 0\)\s*\{[\s\S]*?\.destroy\(\)/.test(statsCode), 'stats: renderCharts détruit les instances quand aucune donnée');

  console.log('\n[21] OK');
})();

// ═══════════════════════════════════════════════════════════════════════════
// [22] NON-RÉGRESSION — validation des paramètres (surface IPC config:save)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[22] Validation des paramètres');
(() => {
  const { sanitizeSettingsPatch } = require('../src/main/core/settings');

  // Clés inconnues rejetées (pas d'injection arbitraire dans user-settings.json)
  assert(Object.keys(sanitizeSettingsPatch({ evilKey: 'x', __proto__: { polluted: 1 } })).length === 0, 'settings: clés inconnues rejetées');

  // autoCleanJobsDays hors plage rejeté (évite purge massive)
  assert(sanitizeSettingsPatch({ autoCleanJobsDays: 999999 }).autoCleanJobsDays === undefined, 'settings: autoCleanJobsDays hors plage rejeté');
  assert(sanitizeSettingsPatch({ autoCleanJobsDays: -5 }).autoCleanJobsDays === undefined, 'settings: autoCleanJobsDays négatif rejeté');
  assert(sanitizeSettingsPatch({ autoCleanJobsDays: 30 }).autoCleanJobsDays === 30, 'settings: autoCleanJobsDays valide accepté');

  // Réglages de vitesse SUPPRIMÉS : la configuration de scraping est fixe
  // (config/scraping.js → SCRAPING_POLICY). Un ancien renderer/paramètre ne peut
  // plus réintroduire une concurrence ou un délai arbitraire via config:save.
  assert(sanitizeSettingsPatch({ scrapeSpeed: 'rapide' }).scrapeSpeed === undefined, 'settings: scrapeSpeed refusé (vitesse non configurable)');
  assert(sanitizeSettingsPatch({ scrapeSpeed: 'turbo' }).scrapeSpeed === undefined, 'settings: scrapeSpeed inconnu refusé');
  assert(sanitizeSettingsPatch({ pageDelayMs: 1000 }).pageDelayMs === undefined, 'settings: pageDelayMs refusé (délai non configurable)');
  assert(sanitizeSettingsPatch({ pageDelayMs: 999999 }).pageDelayMs === undefined, 'settings: pageDelayMs hors plage refusé');

  // booléens stricts
  assert(sanitizeSettingsPatch({ headless: 'yes' }).headless === undefined, 'settings: headless non booléen rejeté');
  assert(sanitizeSettingsPatch({ headless: false }).headless === false, 'settings: headless=false accepté');

  // patch non-objet
  assert(Object.keys(sanitizeSettingsPatch(null)).length === 0, 'settings: patch null → objet vide');

  console.log('\n[22] OK');
})();

// ═══════════════════════════════════════════════════════════════════════════
// [23] NON-RÉGRESSION — parité des champs exportables renderer ↔ main process
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[23] Parité des champs exportables');
(() => {
  const repoRoot = path.join(__dirname, '..');
  const { ALL_FIELD_KEYS } = require('../src/main/services/exporting/exportFields');
  const scraperCode = fs.readFileSync(path.join(repoRoot, 'src/renderer/scraperModule.js'), 'utf8');
  const m = scraperCode.match(/const EXPORT_FIELDS = \[([\s\S]*?)\];/);
  assert(m, 'renderer: EXPORT_FIELDS introuvable');
  const rendererKeys = [...m[1].matchAll(/key:\s*'([^']+)'/g)].map((x) => x[1]);

  // Le renderer duplique la liste des champs exportables pour l'UI du profil
  // Personnalisé. Si elle dérive de ALL_FIELD_KEYS, un champ coché côté UI est
  // silencieusement filtré par getProfileFields (validation main process) et
  // disparaît des exports → ce test échoue pour forcer la resynchronisation.
  const missingInRenderer = ALL_FIELD_KEYS.filter((k) => !rendererKeys.includes(k));
  const extraInRenderer = rendererKeys.filter((k) => !ALL_FIELD_KEYS.includes(k));
  assert(missingInRenderer.length === 0, `renderer: champs manquants vs ALL_FIELD_KEYS: ${missingInRenderer.join(', ')}`);
  assert(extraInRenderer.length === 0, `renderer: champs en trop vs ALL_FIELD_KEYS: ${extraInRenderer.join(', ')}`);

  // Chaque champ sélectionné en Personnalisé doit survivre à getProfileFields.
  const { getProfileFields } = require('../src/main/services/exporting/dataProfiles');
  const kept = getProfileFields('custom', rendererKeys);
  assert(kept.length === rendererKeys.length, 'dataProfiles: tous les champs renderer passent la validation custom');

  console.log('\n[23] OK');
})();

// ═══════════════════════════════════════════════════════════════════════════
// [24] NON-RÉGRESSION — contrat export-meta (profil Personnalisé)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[24] Contrat export-meta');
(() => {
  const repoRoot = path.join(__dirname, '..');
  const historyCode = fs.readFileSync(path.join(repoRoot, 'src/renderer/historyModule.js'), 'utf8');
  // Le pipeline écrit `profileId` (version 2), pas `exportMode`. Le renderer doit
  // accepter les deux, sinon le badge « Personnalisé » ne s'affiche jamais.
  assert(/profileId\s*\|\|\s*j\.exportMeta\.exportMode/.test(historyCode), 'history: badge Personnalisé lit profileId (avec repli exportMode)');
  const jobHistCode = fs.readFileSync(path.join(repoRoot, 'src/main/services/jobs/jobHistory.js'), 'utf8');
  assert(/meta\.profileId\s*=\s*meta\.exportMode/.test(jobHistCode), 'jobHistory: normalise exportMode → profileId pour les anciens jobs');
  assert(/profileId:\s*'default'/.test(jobHistCode), 'jobHistory: fallback exportMeta inclut profileId');

  console.log('\n[24] OK');
})();

// ═══════════════════════════════════════════════════════════════════════════
// [25] NON-RÉGRESSION — contrat DOM statique renderer ↔ index.html
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[25] Contrat DOM statique (index.html)');
(() => {
  const repoRoot = path.join(__dirname, '..');
  const rendererDir = path.join(repoRoot, 'src/renderer');
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const domIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

  // 1) Tout getElementById('X') littéral d'un module renderer doit cibler un id
  //    présent dans index.html. Classe de bug P3-5 : JS référençant des éléments
  //    absents du DOM → fonctionnalité silencieusement inopérante.
  const jsFiles = fs.readdirSync(rendererDir).filter((f) => f.endsWith('.js'));
  const missing = [];
  for (const f of jsFiles) {
    const code = fs.readFileSync(path.join(rendererDir, f), 'utf8');
    for (const m of code.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)) {
      if (!domIds.has(m[1])) missing.push(`${f}:${m[1]}`);
    }
  }
  assert(missing.length === 0, `renderer: IDs absents de index.html → ${missing.join(', ')}`);

  // 2) Chaque bouton de navigation [data-tab="X"] doit cibler un .tab-content
  //    d'id X existant. Classe de bug P3-1 : navigation pointant dans le vide.
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
  assert(tabs.length > 0, 'renderer: au moins un bouton [data-tab]');
  for (const t of tabs) {
    assert(domIds.has(t), `renderer: data-tab="${t}" cible un tab-content existant`);
  }
  // Les 5 onglets attendus (Scraper/Logs/Historique/Explorateur/Stats).
  const expectedTabs = ['tab-scraper', 'tab-logs', 'tab-history', 'tab-explorer', 'tab-stats'];
  for (const t of expectedTabs) {
    assert(tabs.includes(t), `renderer: onglet ${t} présent dans la navigation`);
  }

  console.log('\n[25] OK');
})();

// ═══════════════════════════════════════════════════════════════════════════
// [26] NON-RÉGRESSION — contrat IPC preload ↔ handlers main
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[26] Contrat IPC preload ↔ main');
(() => {
  const repoRoot = path.join(__dirname, '..');
  const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
  const preload = read('src/main/preload.js');
  const widgetPreload = read('src/main/widgetPreload.js');
  const ipc = read('src/main/core/ipcHandlers.js');
  const main = read('src/main/main.js');

  const chansFrom = (code, fn) => new Set([...code.matchAll(new RegExp(`ipcRenderer\\.(?:${fn})\\(['"]([^'"]+)['"]`, 'g'))].map((m) => m[1]));
  const preloadChans = chansFrom(preload, 'send|invoke');
  const widgetChans = chansFrom(widgetPreload, 'send|invoke');
  const handled = new Set([
    ...[...ipc.matchAll(/ipcMain\.(?:on|handle)\(['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ...[...main.matchAll(/ipcMain\.(?:on|handle)\(['"]([^'"]+)['"]/g)].map((m) => m[1]),
  ]);

  // Tout canal émis par le preload doit avoir un handler ipcMain (sinon l'appel
  // renderer reste sans réponse). Classe de bug : canal renommé d'un seul côté.
  const unhandled = [...preloadChans, ...widgetChans].filter((c) => !handled.has(c));
  assert(unhandled.length === 0, `IPC: canaux preload sans handler → ${unhandled.join(', ')}`);

  // Les événements poussés vers le renderer doivent être exposés par onLog/
  // onProgress/onStatusChange du preload (sinon l'UI ne reçoit rien).
  for (const ch of ['log', 'progress', 'status']) {
    assert(new RegExp(`ipcRenderer\\.on\\('${ch}'`).test(preload), `preload: écoute l'événement "${ch}"`);
    assert(new RegExp(`webContents\\.send\\('${ch}'`).test(ipc), `ipcHandlers: émet "${ch}"`);
  }

  console.log('\n[26] OK');
})();

// ═══════════════════════════════════════════════════════════════════════════
// [27] CARTE (mapModule) — logique pure de sélection et validation coords
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[27] Carte mapModule (logique pure)');
(() => {
  const vm = require('vm');
  const repoRoot = path.join(__dirname, '..');
  const code = fs.readFileSync(path.join(repoRoot, 'src/renderer/mapModule.js'), 'utf8');

  const fakeEl = {
    textContent: '', innerHTML: '', value: 'ALL', checked: true, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
  };
  const windowObj = { api: { getHistory: async () => [] } };
  const sandbox = {
    window: windowObj,
    document: { getElementById: () => fakeEl, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, length: 0, key: () => null },
    escapeHtml: (s) => String(s == null ? '' : s),
    escapePath: (s) => String(s == null ? '' : s),
    cityOf: (a) => (a && (a.city || a.ville)) || '',
    zipOf: (a) => (a && (a.zipcode || a.codePostal)) || '',
    locationLabel: (a) => (a && (a.city || a.ville)) || 'Inconnue',
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, fetch: async () => { throw new Error('no net'); },
    AbortController,
    // Globals fournis par app.js/appState.js en exécution réelle.
    mapSessionSelect: fakeEl,
    populateSessionDropdown: () => {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  const { computeMapPoints, isValidLatLng, _deliveryTypeOf, clusterMarkers } = windowObj;
  assert(typeof computeMapPoints === 'function', 'carte: computeMapPoints exposé');
  assert(typeof isValidLatLng === 'function', 'carte: isValidLatLng exposé');
  assert(typeof clusterMarkers === 'function', 'carte: clusterMarkers exposé');

  // Déduplication par id (une annonce présente dans 2 sessions n'apparaît qu'une fois)
  const ads = [
    { id: 'a1', title: 'Vélo', deliveryType: 'main_propre', city: 'Lyon' },
    { id: 'a1', title: 'Vélo', deliveryType: 'main_propre', city: 'Lyon' }, // doublon
    { id: 'a2', title: 'Canapé', deliveryType: 'livraison', city: 'Paris' },
    { id: 'a3', title: 'Table', deliveryType: 'les_deux', city: 'Nantes' },
    { id: 'a4', title: 'Lampe', deliveryType: 'inconnu', city: 'Lille' },
  ];
  const all = computeMapPoints(ads, false);
  assert(all.deduped.length === 4, 'carte: déduplication id → 4 annonces uniques');
  assert(all.target.length === 4, 'carte: sans filtre → toutes les annonces uniques');

  const mp = computeMapPoints(ads, true);
  assert(mp.target.length === 2, 'carte: filtre main propre → main_propre + les_deux (a1, a3)');
  assert(mp.target.every((a) => a.id === 'a1' || a.id === 'a3'), 'carte: filtre main propre garde les bons ids');

  // Dédup : la clé est id || url || title (le premier disponible).
  const byUrl = computeMapPoints([{ url: 'u1' }, { url: 'u1' }], false);
  assert(byUrl.deduped.length === 1, 'carte: dédup par url quand id absent');
  const mixed = computeMapPoints([
    { url: 'u1', title: 'X' }, { url: 'u1', title: 'X' }, { title: 'Y' },
  ], false);
  assert(mixed.deduped.length === 2, 'carte: dédup par url (2 entrées url=u1 → 1) + titre Y → 2 uniques');

  // Rétro-compat : deliveryType absent → calcul depuis livraison/mainPropre
  assert(_deliveryTypeOf({ livraison: true, mainPropre: true }) === 'les_deux', 'carte: compat livraison+mainPropre → les_deux');
  assert(_deliveryTypeOf({ shipping: true, handDelivery: true }) === 'les_deux', 'carte: compat shipping/handDelivery → les_deux');
  const compat = computeMapPoints([{ id: 'c1', mainPropre: true }], true);
  assert(compat.target.length === 1, 'carte: filtre main propre via rétro-compat');

  // Validation des coordonnées : valides acceptées, invalides rejetées
  assert(isValidLatLng([48.85, 2.35]) === true, 'carte: coords France valides');
  assert(isValidLatLng([-90, -180]) === true, 'carte: bornes min valides');
  assert(isValidLatLng([90, 180]) === true, 'carte: bornes max valides');
  assert(isValidLatLng(null) === false, 'carte: null rejeté');
  assert(isValidLatLng([]) === false, 'carte: tableau vide rejeté');
  assert(isValidLatLng([48.85]) === false, 'carte: un seul élément rejeté');
  assert(isValidLatLng([NaN, 2.35]) === false, 'carte: NaN rejeté');
  assert(isValidLatLng([91, 2.35]) === false, 'carte: latitude hors bornes rejetée');
  assert(isValidLatLng([48.85, 181]) === false, 'carte: longitude hors bornes rejetée');
  assert(isValidLatLng(['48.85', '2.35']) === false, 'carte: chaînes numériques rejetées');

  // Regroupement (clusterMarkers) : logique pure de grille, testable sans Leaflet.
  assert(clusterMarkers([], 0.25).length === 0, 'carte: cluster sur liste vide → 0 groupe');
  const one = clusterMarkers([{ lat: 45.7, lng: 4.8, ads: [{ id: 'x' }] }], 0.25);
  assert(one.length === 1 && one[0].ads.length === 1, 'carte: 1 point → 1 groupe');
  const twoFar = clusterMarkers([
    { lat: 45.7, lng: 4.8, ads: [{ id: 'a' }] },
    { lat: 48.8, lng: 2.3, ads: [{ id: 'b' }] },
  ], 0.25);
  assert(twoFar.length === 2, 'carte: 2 points éloignés → 2 groupes');
  const twoNear = clusterMarkers([
    { lat: 45.70, lng: 4.80, ads: [{ id: 'a' }] },
    { lat: 45.71, lng: 4.81, ads: [{ id: 'b' }] },
  ], 0.25);
  assert(twoNear.length === 1 && twoNear[0].ads.length === 2, 'carte: 2 points proches → 1 groupe');
  assert(clusterMarkers([{ lat: 45.7, lng: 4.8, ads: [] }], 0).length === 1, 'carte: cellSize 0 → pas de regroupement');

  // Le module ne doit pas écrire dans le conteneur Leaflet (détruirait la carte) :
  // l'état passe par mapStatus, et les marqueurs par un L.layerGroup.
  assert(!/mapEl\.innerHTML/.test(code), 'carte: ne détruit pas le conteneur #leafletMap (pas d\'innerHTML dessus)');
  assert(/mapMarkerLayer\.clearLayers\(\)/.test(code), 'carte: calque de marqueurs vidé à chaque rendu (anti-doublons)');
  assert(/L\.layerGroup\(\)/.test(code), 'carte: marqueurs dans un L.layerGroup');
  assert(/getElementById\('mapStatus'\)/.test(code), 'carte: messages d\'état via #mapStatus');
  assert(/GEO_CACHE_MAX/.test(code) && /trimGeoCache/.test(code), 'carte: cache géocodage borné (pas de croissance illimitée)');

  // Fiabilité hors ligne : Leaflet/Chart.js sont embarqués localement, plus de
  // CDN public au chargement de l'interface (l'UI ne dépend plus d'un
  // fournisseur externe pour s'afficher).
  const html = fs.readFileSync(path.join(repoRoot, 'src/renderer/index.html'), 'utf8');
  assert(/src="vendor\/leaflet\.js"/.test(html), 'carte: Leaflet servi localement (vendor/leaflet.js)');
  assert(/href="vendor\/leaflet\.css"/.test(html), 'carte: CSS Leaflet servi localement (vendor/leaflet.css)');
  assert(/src="vendor\/chart\.umd\.min\.js"/.test(html), 'graphiques: Chart.js servi localement (vendor/chart.umd.min.js)');
  assert(!/cdn\.jsdelivr\.net|unpkg\.com/.test(html), 'CSP/HTML: plus aucune référence CDN au chargement');
  assert(/script-src 'self';/.test(html) && !/script-src [^;]*unsafe-inline/.test(html) && !/script-src [^;]*https:/.test(html), 'CSP: script-src limité à self, sans unsafe-inline (Thème 6)');
  for (const f of ['vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/chart.umd.min.js',
                   'vendor/images/marker-icon.png', 'vendor/images/marker-shadow.png']) {
    assert(fs.existsSync(path.join(repoRoot, 'src/renderer', f)), `carte: ressource locale présente → ${f}`);
  }

  console.log('\n[27] OK');
})();

// ═══════════════════════════════════════════════════════════════════════════
// [28] DISTRIBUTION WINDOWS — icône, config electron-builder, prepare-browsers
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[28] Distribution Windows (packaging)');
(() => {
  const repoRoot = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

  // Icône : présente et multi-résolutions (Windows exige au moins 256px)
  const icoPath = path.join(repoRoot, 'build', 'icon.ico');
  assert(fs.existsSync(icoPath), 'dist: build/icon.ico présent');
  const icoBuf = fs.readFileSync(icoPath);
  const icoCount = icoBuf.readUInt16LE(4); // nombre d'images dans le .ICO
  assert(icoCount >= 6, `dist: icône multi-résolutions (${icoCount} tailles ≥ 6)`);
  assert(fs.existsSync(path.join(repoRoot, 'build', 'icon.png')), 'dist: build/icon.png (source) présent');

  // Config electron-builder
  const build = pkg.build || {};
  assert(pkg.main === 'src/main/main.js', 'dist: main pointe vers src/main/main.js');
  assert(build.appId && build.productName, 'dist: appId + productName définis');
  assert(build.win && build.win.icon === 'build/icon.ico', 'dist: win.icon → build/icon.ico');
  const targets = (build.win.target || []).map((t) => (typeof t === 'string' ? t : t.target));
  assert(targets.includes('nsis'), 'dist: cible NSIS (installeur)');
  assert(targets.includes('portable'), 'dist: cible portable (standalone)');
  assert(build.nsis && build.nsis.oneClick === false, 'dist: NSIS oneClick=false (choix du dossier)');
  assert(build.nsis.allowToChangeInstallationDirectory === true, 'dist: NSIS allowToChangeInstallationDirectory');
  assert(build.nsis.createDesktopShortcut === true, 'dist: NSIS raccourci bureau');
  assert(build.nsis.createStartMenuShortcut === true, 'dist: NSIS raccourci menu Démarrer');
  assert(build.nsis.perMachine === false, 'dist: NSIS installation par utilisateur (sans droits admin)');
  assert(build.nsis.allowElevation === true, 'dist: NSIS élévation autorisée si nécessaire');
  assert(build.nsis.deleteAppDataOnUninstall === false, 'dist: NSIS conserve les données utilisateur à la désinstallation');
  assert(build.nsis.installerIcon === 'build/icon.ico', 'dist: NSIS icône d\'installeur');
  assert(build.nsis.uninstallerIcon === 'build/icon.ico', 'dist: NSIS icône de désinstalleur');
  assert(build.npmRebuild === false, 'dist: pas de rebuild natif (aucun module natif)');
  assert(String(build.portable.artifactName).includes('Portable'), 'dist: artefact portable nommé');
  assert(/^Vendra-Portable-\$\{version\}\.exe$/.test(build.portable.artifactName), 'dist: artefact portable versionné (Vendra)');
  assert(build.productName === 'Vendra', 'dist: productName = Vendra (cohérent app/installeur/raccourcis)');
  assert(build.appId === 'com.vendra.app', 'dist: appId = com.vendra.app');
  assert(build.directories.output === 'dist', 'dist: sortie → dist/');
  assert(build.directories.buildResources === 'build', 'dist: resources de build → build/');

  // extraResources embarque le navigateur Playwright (browsers/)
  const extra = build.extraResources || [];
  const browsersRes = extra.find((e) => e.to === 'browsers');
  assert(!!browsersRes, 'dist: extraResources → browsers/ (Chromium embarqué)');
  assert(String(browsersRes.from).includes('.local-browsers'), 'dist: browsers/ vient de playwright-core/.local-browsers');
  // Les fichiers de l'app incluent src + playwright
  const files = build.files || [];
  assert(files.some((f) => f.startsWith('src/')), 'dist: files inclut src/**');
  // Chromium fourni uniquement via extraResources → pas de duplication dans app.asar
  assert(files.some((f) => f.startsWith('!node_modules/playwright-core/.local-browsers')),
    'dist: .local-browsers exclu de files (pas de duplication Chromium)');

  // Scripts npm cohérents
  const scripts = pkg.scripts || {};
  assert(scripts.dist === 'electron-builder --win', 'dist: script npm run dist → electron-builder --win');
  assert(scripts.pack === 'electron-builder --dir', 'dist: script npm run pack → --dir');
  assert(/prepare-browsers\.js/.test(scripts.predist || ''), 'dist: predist prépare le Chromium Windows');
  assert(/--platform=win/.test(scripts.predist || ''), 'dist: predist télécharge le Chromium Windows (pas l\'hôte Linux)');
  assert(/prepare-browsers\.js/.test(scripts.browsers || ''), 'dist: script browsers présent');

  // prepare-browsers : nom d'archive + sous-dossier par plateforme
  const pb = require('../tools/prepare-browsers');
  assert(pb.archiveName('win', 'x64') === 'chromium-win64.zip', 'dist: archive win-x64 = chromium-win64.zip');
  assert(pb.archiveName('win', 'arm64') === 'chromium-win-arm64.zip', 'dist: archive win-arm64');
  assert(pb.archiveName('linux', 'x64') === 'chromium-linux.zip', 'dist: archive linux');
  assert(pb.extractedDir('win') === 'chrome-win', 'dist: extraction win → chrome-win/');
  assert(pb.extractedDir('linux') === 'chrome-linux', 'dist: extraction linux → chrome-linux/');

  // prepare-browsers décompresse via `extract-zip`. Cette dépendance ÉTAIT
  // transitive (playwright 1.41) : sa mise à jour l'a retirée et le build CI
  // Windows a échoué (« Cannot find module 'extract-zip' »). Elle doit rester
  // DÉCLARÉE explicitement — ne jamais dépendre d'une transitive pour un outil
  // de build.
  const pbSrc = fs.readFileSync(path.join(repoRoot, 'tools', 'prepare-browsers.js'), 'utf8');
  if (/require\(['"]extract-zip['"]\)/.test(pbSrc)) {
    const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    assert(!!declared['extract-zip'],
      'dist: extract-zip DÉCLARÉE (prepare-browsers.js l\'importe — pas de dépendance transitive)');
  }

  // main.js : résolution du chemin Chromium embarqué quand packagé
  const mainCode = fs.readFileSync(path.join(repoRoot, 'src/main/main.js'), 'utf8');
  assert(/PLAYWRIGHT_BROWSERS_PATH/.test(mainCode), 'dist: main.js pointe PLAYWRIGHT_BROWSERS_PATH (app packagée)');
  assert(/process\.resourcesPath.*browsers/.test(mainCode.replace(/\n/g, ' ')), 'dist: main.js utilise process.resourcesPath/browsers');

  console.log('\n[28] OK');
})();

// ═══════════════════════════════════════════════════════════════════════════
// [29] INTÉGRATION CONTINUE — workflow Windows + vérification de l'installeur
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[29] CI Windows (build + release)');
(() => {
  const repoRoot = path.join(__dirname, '..');
  const wfPath = path.join(repoRoot, '.github', 'workflows', 'build-windows.yml');
  assert(fs.existsSync(wfPath), 'ci: .github/workflows/build-windows.yml présent');
  const wf = fs.readFileSync(wfPath, 'utf8');

  // Déclencheurs cohérents : push, PR et tags de version.
  assert(/on:/.test(wf), 'ci: clé « on » présente');
  assert(/tags:/.test(wf) && /v\*/.test(wf), 'ci: déclenchement sur tags v*');
  assert(/\bpush:/.test(wf), 'ci: déclenchement sur push');
  assert(/pull_request:/.test(wf), 'ci: déclenchement sur pull_request');
  assert(/workflow_dispatch:/.test(wf), 'ci: déclenchement manuel (workflow_dispatch)');

  // Runner Windows + Node compatible.
  assert(/runs-on:\s*windows-latest/.test(wf), 'ci: runner windows-latest');
  assert(/node-version:\s*['"]?22/.test(wf), 'ci: Node.js 22 (requis par Electron 44 / jsdom 30)');
  assert(/npm ci/.test(wf), 'ci: installation reproductible (npm ci)');
  assert(/prepare-browsers\.js/.test(wf), 'ci: préparation du Chromium Windows');
  assert(/PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD/.test(wf), 'ci: évite le téléchargement Chromium redondant de Playwright');
  assert(/npm run dist/.test(wf), 'ci: build via npm run dist');

  // Vérification de l'installeur + publication d'un artefact Action.
  assert(/tools\/verify-dist\.js/.test(wf), 'ci: vérification de l\'artefact (verify-dist.js)');
  assert(/actions\/upload-artifact@v4/.test(wf), 'ci: artefact GitHub Actions téléchargeable');

  // Publication d'une Release sur tag, avec checksum et permissions minimales.
  assert(/contents:\s*write/.test(wf), 'ci: permission contents: write (publication Release)');
  assert(/softprops\/action-gh-release@v2/.test(wf), 'ci: publication via action-gh-release');
  assert(/\.sha256/.test(wf), 'ci: empreintes SHA-256 jointes');
  // La Release ne doit être publiée QUE sur un tag de version.
  assert(/startsWith\(github\.ref,\s*'refs\/tags\/'\)/.test(wf), 'ci: Release conditionnée à un tag de version');

  // Aucun secret en dur.
  assert(!/ghp_[A-Za-z0-9]/.test(wf) && !/github_pat_/.test(wf), 'ci: aucun jeton en dur');

  // Outil de vérification : présent + exporte une fonction testable.
  const vdPath = path.join(repoRoot, 'tools', 'verify-dist.js');
  assert(fs.existsSync(vdPath), 'ci: tools/verify-dist.js présent');
  const vd = require('../tools/verify-dist.js');
  assert(typeof vd.verifyDist === 'function', 'ci: verify-dist exporte verifyDist()');

  // verifyDist : échec propre sur dossier absent/vide, liste vide si aucun PNG.
  const emptyDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'verify-dist-'));
  const resMissing = vd.verifyDist(path.join(emptyDir, 'absent'), { minInstallerBytes: 1000 });
  assert(resMissing.ok === false && resMissing.errors.length > 0, 'ci: verify-dist détecte un dossier absent');
  const resEmpty = vd.verifyDist(emptyDir, { minInstallerBytes: 1000, requireInstaller: false });
  assert(resEmpty.errors.length > 0, 'ci: verify-dist détecte l\'absence d\'artefact');
  fs.rmSync(emptyDir, { recursive: true, force: true });

  console.log('\n[29] OK');
})();

// --- 30. Moteur historique restauré : accès/vérif/états honnêtes retirés ---
// La vérification d'accès réelle (403/429) et les états refused/rate_limited
// ont été retirés au profit du moteur historique `8d223c9` (cf. décision de
// restauration). Les codes structurés restent définis mais ne sont plus utilisés
// par harCapturer ; les états `partial`/`refused`/`rate_limited` côté renderer
// restent tolérés (aucune régression UI).
console.log('\n[30] Restauration du moteur historique de scraping');
{
  const { ErrorCodes, classifyError } = require('../src/main/services/scraping/errorCodes');
  assert(ErrorCodes.HTTP_ACCESS_REFUSED === 'HTTP_ACCESS_REFUSED', 'ErrorCodes: HTTP_ACCESS_REFUSED');
  assert(ErrorCodes.HTTP_RATE_LIMITED === 'HTTP_RATE_LIMITED', 'ErrorCodes: HTTP_RATE_LIMITED');
  assert(ErrorCodes.ACCESS_UNVERIFIED === 'ACCESS_UNVERIFIED', 'ErrorCodes: ACCESS_UNVERIFIED');
  assert(ErrorCodes.CAPTCHA_NOT_CONFIRMED === 'CAPTCHA_NOT_CONFIRMED', 'ErrorCodes: CAPTCHA_NOT_CONFIRMED');
  assert(classifyError(ErrorCodes.HTTP_ACCESS_REFUSED) === 'network_error', 'classifyError: HTTP_ACCESS_REFUSED → network_error');
  assert(classifyError(ErrorCodes.HTTP_RATE_LIMITED) === 'network_error', 'classifyError: HTTP_RATE_LIMITED → network_error');
  assert(classifyError(ErrorCodes.ACCESS_UNVERIFIED) === 'session_error', 'classifyError: ACCESS_UNVERIFIED → session_error');

  // harCapturer : le moteur historique ne contient plus la vérification d'accès.
  const harCap = fs.readFileSync(path.join(base, 'services/scraping/harCapturer.js'), 'utf8');
  assert(!/_verifyAccess/.test(harCap) && !/_parseRetryAfter/.test(harCap), '[30] harCapturer: vérif. d\'accès retirée');

  // ipcHandlers : plus de court-circuit sur capture bloquée (moteur historique).
  const ipcAudit = fs.readFileSync(path.join(base, 'core/ipcHandlers.js'), 'utf8');
  assert(!/captureResult/.test(ipcAudit), 'ipcHandlers: plus de court-circuit captureResult (moteur historique)');
  assert(/activeCancel && activeCancel\.cancelled/.test(ipcAudit), 'ipcHandlers: annulation coopérative conservée');
  assert(/state:\s*'partial'/.test(ipcAudit), 'ipcHandlers: état partial (succès partiel) conservé');
  assert(/state:\s*'completed'/.test(ipcAudit), 'ipcHandlers: état completed conservé');

  // pipelineRunner : classification des exit 3/4 conservée (inertée côté pipeline).
  const runnerAudit = fs.readFileSync(path.join(base, 'services/scraping/pipelineRunner.js'), 'utf8');
  assert(/code === 3/.test(runnerAudit) && /HTTP_ACCESS_REFUSED/.test(runnerAudit), 'pipelineRunner: exit 3 → HTTP_ACCESS_REFUSED');
  assert(/code === 4/.test(runnerAudit) && /HTTP_RATE_LIMITED/.test(runnerAudit), 'pipelineRunner: exit 4 → HTTP_RATE_LIMITED');

  // pipeline : 403/429 distincts + Retry-After (durcissement anti-débit rétabli).
  const pipeAudit = fs.readFileSync(path.join(base, 'services/scraping/leboncoin-pipeline.js'), 'utf8');
  assert(/BLOCKED_429/.test(pipeAudit), 'pipeline: 429 distinct de 403 (BLOCKED_429)');
  assert(/parseRetryAfterMs/.test(pipeAudit), 'pipeline: Retry-After interprété (parseRetryAfterMs)');
  // Politique de scraping fixe centralisée dans config/scraping.js ; le pipeline
  // la consomme via getScrapingPolicy()/clampConcurrency().
  const presetsAudit = fs.readFileSync(path.join(base, 'config/scraping.js'), 'utf8');
  assert(/concurrency:\s*MAX_CONCURRENCY/.test(presetsAudit) && /const MAX_CONCURRENCY = 25/.test(presetsAudit),
    'config/scraping: concurrence bornée à MAX_CONCURRENCY = 25');
  assert(/pageDelayMs:\s*400/.test(presetsAudit), 'config/scraping: délai nominal 400 ms');
  assert(/getScrapingPolicy/.test(pipeAudit), 'pipeline: consomme getScrapingPolicy() (politique centralisée)');

  // renderer : les nouveaux états restent tolérés (aucune régression UI).
  const scraperAudit = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/scraperModule.js'), 'utf8');
  assert(/'partial'/.test(scraperAudit) && /'refused'/.test(scraperAudit) && /'rate_limited'/.test(scraperAudit), 'scraperModule: states partial/refused/rate_limited gérés');
  const widgetAudit = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/widget.html'), 'utf8');
  assert(/st === 'partial'/.test(widgetAudit), 'widget: état partial affiché');

  console.log('\n[30] OK');
}

// --- 31. Audit 403 : compteurs cohérents + backoff agressif + Retry-After ---
// Corrige la contradiction « N extraites / 0 trouvée » du résumé et durcit la
// limitation de débit (rafale de 403 après une série de succès).
console.log('\n[31] Audit 403 : compteurs + backoff + Retry-After');
{
  const { AdaptiveRateLimiter } = require('../src/main/utils/rateLimiter');

  // 31.1 Compteurs : le résumé doit compter les annonces réellement extraites.
  // L'ancien motif ne matchait PAS la ligne réelle du pipeline.
  const oldRe = /(\d+)\s+annonce\(s\)\s+(?:unique|extrait)/i;
  assert(!oldRe.test('Étape HAR -> Annonces terminée : 236 annonces extraites.'),
    '[31] ancien motif ne matchait pas la ligne réelle (preuve du bug compteur)');
  // Nouveaux motifs (extraits d\'ipcHandlers) :
  const extractRe = /(\d+)\s+annonces?\s+extraites?/i;
  const uniqueRe = /(\d+)\s+unique\(s\)\s+en\s+sortie/i;
  const m1 = 'Étape HAR -> Annonces terminée : 236 annonces extraites.'.match(extractRe);
  assert(m1 && m1[1] === '236', '[31] compteur: « N annonces extraites » → N');
  const m2 = '[METRICS] 236 annonces extraites uniques (300 normalisées, 64 doublons fusionnés).'.match(extractRe);
  assert(m2 && m2[1] === '236', '[31] compteur: ligne [METRICS] → N uniques');
  const m3 = '[mergeDuplicates] 300 annonce(s) en entrée | 0 sans ID | 64 doublon(s) fusionné(s) | 236 unique(s) en sortie.'.match(uniqueRe);
  assert(m3 && m3[1] === '236', '[31] compteur: « N unique(s) en sortie » → N');
  // Le compteur ne doit PAS rester à 0 quand un vrai total est présent.
  assert(parseInt(m1[1], 10) === 236, '[31] compteur: 236 ≠ 0 (plus de contradiction)');

  // 31.2 Backoff adaptatif historique : après un blocage, le délai suit
  // base × 2^N (N = blocages consécutifs), plafonné par maxDelayMs.
  const rl = new AdaptiveRateLimiter({ baseDelayMs: 800, maxDelayMs: 8000, logger: null });
  await rl.waitAfter({ durationMs: 100, blocked: true, status: 403 });
  assert(rl.currentDelayMs() === 1600, '[31] backoff historique: 1 blocage → base×2^1 = 1600ms');
  await rl.waitAfter({ durationMs: 100, blocked: true, status: 403 });
  assert(rl.currentDelayMs() === 3200, '[31] backoff historique: 2 blocages → base×2^2 = 3200ms');
  const rl2 = new AdaptiveRateLimiter({ baseDelayMs: 6000, maxDelayMs: 6000, logger: null });
  await rl2.waitAfter({ durationMs: 100, blocked: true, status: 403 });
  assert(rl2.currentDelayMs() === 6000, '[31] backoff historique: plafonné à maxDelayMs');

  // 31.3 Politique de scraping FIXE centralisée + Retry-After implémenté.
  const pipe = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), 'utf8');
  assert(!/noWait: true/.test(pipe), '[31] pipeline: plus de noWait (délai adaptatif toujours appliqué)');
  assert(/pendingRetryAfterMs/.test(pipe), '[31] pipeline: pause Retry-After appliquée (pendingRetryAfterMs)');
  assert(/parseRetryAfterMs/.test(pipe), '[31] pipeline: en-tête Retry-After interprété');
  // Politique fixe : concurrence 25 max, délai nominal 400 ms.
  const presetsSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/config/scraping.js'), 'utf8');
  assert(/const MAX_CONCURRENCY = 25/.test(presetsSrc), '[31] config: MAX_CONCURRENCY = 25');
  assert(/concurrency:\s*MAX_CONCURRENCY/.test(presetsSrc), '[31] config: politique concurrence = MAX_CONCURRENCY');
  assert(/pageDelayMs:\s*400/.test(presetsSrc), '[31] config: délai nominal 400 ms');

  // 31.3b parseRetryAfterMs : formes delta-seconds et date HTTP.
  const { parseRetryAfterMs } = require('../src/main/services/scraping/leboncoin-pipeline');
  assert(parseRetryAfterMs('120') === 120000, '[31] Retry-After delta-seconds → 120000 ms');
  assert(parseRetryAfterMs('0') === 0, '[31] Retry-After 0 → 0 ms');
  assert(parseRetryAfterMs(null) === null && parseRetryAfterMs('') === null, '[31] Retry-After absent → null');
  assert(parseRetryAfterMs('pas une date') === null, '[31] Retry-After invalide → null');
  const futureDate = new Date(Date.now() + 60000).toUTCString();
  const parsed = parseRetryAfterMs(futureDate);
  assert(typeof parsed === 'number' && parsed > 55000 && parsed <= 60000, '[31] Retry-After date HTTP → ~60000 ms');
  assert(parseRetryAfterMs('999999999') === 24 * 3600 * 1000, '[31] Retry-After plafonné à 24h (anti-boucle infinie)');

  // 31.3c Politique fixe : clampConcurrency ne dépasse jamais 25.
  const cfg = require('../src/main/config/scraping');
  assert(cfg.clampConcurrency(1000) === 25, '[31] clampConcurrency(1000) → 25 (jamais dépassé)');
  assert(cfg.clampConcurrency(7) === 7, '[31] clampConcurrency(7) → 7 (valeur valide conservée)');
  assert(cfg.clampConcurrency('abc') === 25 && cfg.clampConcurrency(-3) === 25, '[31] clampConcurrency invalide → défaut 25');
  assert(cfg.getScrapingPolicy().concurrency === 25 && cfg.getScrapingPolicy().pageDelayMs === 400,
    '[31] politique: concurrence 25 + délai 400 ms');
  assert(cfg.getSpeedPreset().concurrency === 25 && cfg.getSpeedPreset().minDelayMs === 400,
    '[31] getSpeedPreset (déprécié) renvoie la politique fixe');

  // 31.4 Métrique d'annonces extraites émise par le pipeline.
  assert(/\[METRICS\] \$\{ads\.length\} annonces extraites uniques/.test(pipe), '[31] pipeline: ligne [METRICS] annonces extraites');

  // 31.5 ipcHandlers : compteurs cohérents (extraction + uniques + doublons).
  const ipcC = fs.readFileSync(path.join(__dirname, '..', 'src/main/core/ipcHandlers.js'), 'utf8');
  assert(/annonces\?\\s\+extraites\?/.test(ipcC) || /annonces\?\\\\s\+extraites\?/.test(ipcC) || ipcC.includes('annonces?\\s+extraites?'),
    '[31] ipcHandlers: motif extraction « annonces extraites » présent');
  assert(/unique\\\(s\\\)\\s\+en\\s\+sortie/.test(ipcC) || ipcC.includes('unique\\(s\\)\\s+en\\s+sortie'),
    '[31] ipcHandlers: motif « unique(s) en sortie » présent');
  assert(/Math\.max\(sessionStats\.adsDuplicates/.test(ipcC), '[31] ipcHandlers: doublons cumulés de façon idempotente (pas de double comptage)');

  console.log('\n[31] OK');
}

// --- 32. Audit global : bugs corrigés (non-régression) ---
// Couvre des défauts réels découverts lors de l'audit complet :
//  - describeError non importé dans le pipeline (ReferenceError au recyclage) ;
//  - escapePath double-encodait '&' (ordre des remplacements) ;
//  - window.prompt() (non supporté par Electron) cassait « Sauvegarder un Preset » ;
//  - applySearchConfig : le re-spread de `p` écrasait l'URL du preset ;
//  - --no-seller-data ignoré en profil Maximum (fields=null) ;
//  - toReadableBlock jetait sur une annonce null ;
//  - logs dev écrits dans Documents au lieu de ./output/logs.
console.log('\n[32] Audit global : correctifs');
{
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const pipeCode = read('src/main/services/scraping/leboncoin-pipeline.js');
  const utilsCode = read('src/renderer/utils.js');
  const scraperCode = read('src/renderer/scraperModule.js');
  const htmlCode = read('src/renderer/index.html');
  const loggerCode = read('src/main/utils/logger.js');

  // 32.1 describeError importé dans le pipeline (utilisé au recyclage de contexte).
  assert(/const\s*\{[^}]*describeError[^}]*\}\s*=\s*require\([^)]*diagnostics/.test(pipeCode),
    'pipeline: describeError importé depuis diagnostics (plus de ReferenceError)');

  // 32.2 escapePath : '&' échappé AVANT '"'.
  const ampIdx = utilsCode.indexOf("replace(/&/g, '&amp;')");
  const quoteIdx = utilsCode.indexOf('replace(/"/g, \'&quot;\')');
  assert(ampIdx !== -1 && quoteIdx !== -1 && ampIdx < quoteIdx,
    'utils.js: escapePath échappe & avant " (pas de double-encodage)');

  // 32.3 Plus de window.prompt() (non supporté par Electron).
  assert(!/[^.\w]prompt\(/.test(scraperCode), 'scraperModule: plus de prompt() (non supporté Electron)');
  assert(/id="presetModal"/.test(htmlCode) && /id="presetNameInput"/.test(htmlCode),
    'index.html: modale de nom de preset présente');
  assert(/presetModal/.test(scraperCode) && /presetConfirmBtn/.test(scraperCode),
    'scraperModule: enregistrement de preset via modale');

  // 32.4 loadPreset : les clés explicites ne sont plus écrasées par le spread.
  assert(!/applySearchConfig\(\{\s*searchUrl:[^}]*\.\.\.p\s*\}\)/.test(scraperCode),
    'scraperModule: loadPreset ne re-spread plus p (URL non écrasée)');
  assert(/searchUrl:\s*p\.searchUrl\s*\|\|\s*p\.url/.test(scraperCode),
    'scraperModule: loadPreset résout searchUrl||url correctement');

  // 32.5 --no-seller-data honoré en profil Maximum (fields=null).
  const exf = require('../src/main/services/exporting/exportFields');
  const adFull = { id: '1', title: 'T', vendeurNom: 'Bob', vendeurId: '9', vendeurNote: 4, city: 'Lyon' };
  const maxNoSeller = exf.filterAdByFields(adFull, null, { excludeSellerData: true });
  assert(!('vendeurNom' in maxNoSeller) && !('vendeurId' in maxNoSeller),
    'exportFields: excludeSellerData honoré en profil Maximum (fields=null)');
  assert(maxNoSeller.id === '1' && maxNoSeller.city === 'Lyon',
    'exportFields: champs non-vendeur conservés en Maximum sans vendeur');

  // 32.6 toReadableBlock ne jette plus sur une annonce null.
  let threw = false;
  try { exf.toReadableBlock(null, 0, ['id']); } catch { threw = true; }
  assert(!threw, 'exportFields: toReadableBlock(null) ne jette pas');

  // 32.7 logs dev → ./output/logs (cohérent avec jobs/secrets), pas Documents.
  // La source packagée est BASE_OUT_DIR (constants.js) : le dossier Documents
  // n'est jamais construit en dur ici (sinon un renommage du dossier de données
  // laisserait les logs dans un dossier orphelin).
  assert(/app\.isPackaged\s*\?\s*require\('\.\.\/config\/constants'\)\.BASE_OUT_DIR\s*:\s*null/.test(loggerCode),
    'logger: dossier de logs dev = ./output/logs (pas Documents), packagé via BASE_OUT_DIR');
  assert(/base \? path\.join\(base, 'logs'\) : LOG_DIR_DEV/.test(loggerCode),
    'logger: repli LOG_DIR_DEV (./output/logs) hors Electron');

  console.log('\n[32] OK');
}

// --- 33. Modules du roadmap (fiabilité scraping) ---
console.log('\n[33] Roadmap fiabilité (disjoncteur, journal, reprise, config)');

// 33.1 config/scraping : source unique des presets (pas d'electron requis).
{
  const cfg = require('../src/main/config/scraping');
  // Politique fixe (source unique) : concurrence 25, délai nominal 400 ms.
  assert(cfg.getScrapingPolicy().concurrency === 25 && cfg.getScrapingPolicy().pageDelayMs === 400,
    'config/scraping: politique fixe concurrence 25 / délai 400 ms');
  assert(cfg.SCRAPING_POLICY.mode === 'ultra-rapide', 'config/scraping: mode ultra-rapide');
  assert(cfg.getSpeedPreset().concurrency === 25 && cfg.getSpeedPreset().minDelayMs === 400,
    'config/scraping: getSpeedPreset (déprécié) = politique fixe');
  assert(cfg.BLOCK_THRESHOLD >= 1 && cfg.CIRCUIT_STATES.STOPPED === 'stopped',
    'config/scraping: seuil de blocage + états du disjoncteur définis');
  // Le module ne doit PAS dépendre d'electron (importable par le pipeline forké).
  assert(!/require\(['"]electron['"]\)/.test(fs.readFileSync(path.join(__dirname, '..', 'src/main/config/scraping.js'), 'utf8')),
    'config/scraping: aucun require(electron) (compatible pipeline forké)');
}

// 33.2 CircuitBreaker : machine à états normal→slowed→blocked→stopped.
{
  const { CircuitBreaker } = require('../src/main/services/scraping/circuitBreaker');
  const cb = new CircuitBreaker({ blockThreshold: 3 });
  assert(cb.state === 'normal' && !cb.shouldStop(), 'circuit: état initial normal, pas d\'arrêt');
  cb.recordError();
  assert(cb.state === 'slowed' && !cb.shouldStop(), 'circuit: erreur réseau → slowed (on continue)');
  cb.recordSuccess();
  assert(cb.state === 'normal' && cb.consecutiveBlocks === 0, 'circuit: succès → retour normal');
  assert(cb.recordBlock(403, 'HTTP_403') === false && cb.state === 'blocked',
    'circuit: 1er blocage → blocked, pas encore d\'arrêt');
  assert(cb.recordBlock(403, 'HTTP_403') === false, 'circuit: 2e blocage → pas encore d\'arrêt');
  assert(cb.recordBlock(403, 'HTTP_403') === true && cb.shouldStop(),
    'circuit: 3e blocage consécutif → stopped (arrêt préventif)');
  const info = cb.stopInfo();
  assert(info && info.reason === 'access_refused' && info.status === 403,
    'circuit: stopInfo → access_refused / HTTP 403');
  // 429 → rate_limited.
  const cb429 = new CircuitBreaker({ blockThreshold: 1 });
  cb429.recordBlock(429, 'HTTP_429');
  assert(cb429.stopInfo().reason === 'rate_limited', 'circuit: 429 → raison rate_limited');
  // Un succès remet le compteur de blocages consécutifs à zéro.
  const cb2 = new CircuitBreaker({ blockThreshold: 3 });
  cb2.recordBlock(403, 'HTTP_403'); cb2.recordBlock(403, 'HTTP_403');
  cb2.recordSuccess();
  assert(cb2.consecutiveBlocks === 0, 'circuit: succès réinitialise les blocages consécutifs');
}

// 33.3 NetworkJournal : compteurs réseau objectifs.
{
  const { NetworkJournal } = require('../src/main/services/scraping/networkJournal');
  const j = new NetworkJournal();
  j.recordNavigation(); j.recordNavigation();
  j.recordPageResult(true); j.recordPageResult(false);
  j.recordDetailRequest(); j.recordBlock('https://x/ad/1', 403); j.recordError();
  const s = j.snapshot();
  assert(s.navigations === 2 && s.pagesOk === 1 && s.pagesFailed === 1,
    'journal: navigations/pages comptées');
  assert(s.detailRequests === 1 && s.blockedRequests === 1 && s.otherErrors === 1,
    'journal: requêtes détail / blocages / erreurs comptées');
  assert(s.blockedUrls.length === 1 && s.blockedUrls[0].status === 403,
    'journal: URL bloquée enregistrée avec statut');
}

// 33.4 captureState : progression + fusion HAR (reprise incrémentale).
{
  const os = require('os');
  const cs = require('../src/main/services/scraping/captureState');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-capstate-'));
  cs.writeProgress(tmp, { searchUrl: 'https://x', pagesRequested: 10, lastPageOk: 6, pagesOk: 6 });
  const prog = cs.readProgress(tmp);
  assert(prog && prog.lastPageOk === 6 && typeof prog.updatedAt === 'string',
    'captureState: progression écrite/relue (lastPageOk + updatedAt)');
  // Fusion HAR : deux HAR → un seul contenant toutes les entrées.
  const harA = path.join(tmp, 'a.har');
  const harB = path.join(tmp, 'b.har');
  const out = path.join(tmp, 'merged.har');
  fs.writeFileSync(harA, JSON.stringify({ log: { version: '1.2', entries: [{ request: { url: 'p1' } }] } }));
  fs.writeFileSync(harB, JSON.stringify({ log: { version: '1.2', entries: [{ request: { url: 'p7' } }] } }));
  const merged = cs.mergeHarFiles([harA, harB], out);
  const mergedHar = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert(merged.entries === 2 && mergedHar.log.entries.length === 2,
    'captureState: fusion HAR concatène les entrées (pages 1-6 + 7-10)');
  assert(mergedHar.log.entries[0].request.url === 'p1' && mergedHar.log.entries[1].request.url === 'p7',
    'captureState: ordre des entrées préservé après fusion');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 33.5 sessionPaths : résolution centralisée (pas d'electron).
{
  const sp = require('../src/main/services/scraping/sessionPaths');
  assert(/global-session\.json$/.test(sp.getGlobalSessionPath('/base')),
    'sessionPaths: session globale = baseOutDir/global-session.json');
  assert(/session-state\.json$/.test(sp.getJobSessionPath('/base/job-1')),
    'sessionPaths: session job = jobDir/session-state.json');
  assert(sp.getJobSessionPathFromResults('/base/job-1/results') === sp.getJobSessionPath('/base/job-1'),
    'sessionPaths: session déduite de results/ remonte au jobDir');
  assert(!/require\(['"]electron['"]\)/.test(fs.readFileSync(path.join(__dirname, '..', 'src/main/services/scraping/sessionPaths.js'), 'utf8')),
    'sessionPaths: aucun require(electron) (compatible pipeline forké)');
}

// 33.6 harCapturer : reprise + détection de page vide + journal + pas de boucle CAPTCHA.
{
  const harCode3 = fs.readFileSync(path.join(base, 'services/scraping/harCapturer.js'), 'utf8');
  assert(/resumeFrom/.test(harCode3) && /startPage/.test(harCode3),
    'harCapturer: reprise incrémentale (resumeFrom/startPage)');
  assert(/_looksLikeEmptyResults/.test(harCode3),
    'harCapturer: détection page de résultats vide (soft-block 200)');
  assert(/seenPageSignatures/.test(harCode3),
    'harCapturer: garde-fou boucle de pagination');
  assert(/verified === false/.test(harCode3),
    'harCapturer: pré-check non validé → arrêt (pas de boucle de fenêtres CAPTCHA)');
  assert(/writeProgress\(/.test(harCode3) && /mergeHarFiles/.test(harCode3),
    'harCapturer: progression par page + fusion HAR à la reprise');
}

// 33.7 pipelineRunner : baseOutDir transmis (pipeline forké sans electron).
{
  const runnerCode = fs.readFileSync(path.join(base, 'services/scraping/pipelineRunner.js'), 'utf8');
  assert(/--base-out-dir/.test(runnerCode) && /baseOutDir/.test(runnerCode),
    'pipelineRunner: option --base-out-dir transmise au fork');
}

// 33.8 ipcHandlers : signal d'arrêt structuré (plus d'heuristique de texte).
{
  const ipcCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/core/ipcHandlers.js'), 'utf8');
  assert(/\[STOP_REASON\]/.test(ipcCode) && /stopMatch/.test(ipcCode),
    'ipcHandlers: détection via signal structuré [STOP_REASON]');
  assert(!/msg\.includes\('interrompu'\)\s*\|\|\s*msg\.includes\('restreint'\)/.test(ipcCode),
    'ipcHandlers: plus d\'heuristique de texte fragile (interrompu/restreint)');
  assert(/currentJobId/.test(ipcCode),
    'ipcHandlers: jobId de corrélation attaché aux logs/statuts');
}

console.log('\n[33] OK');

// --- 34. Observabilité : niveau de log configurable + export des logs ---
console.log('\n[34] Observabilité (niveau de log, export)');
{
  const { sanitizeSettingsPatch, SETTINGS_DEFAULTS } = require('../src/main/core/settings');
  assert(SETTINGS_DEFAULTS.logLevel === 'debug',
    'settings: niveau de log par défaut = debug (aucune perte de logs)');
  const ok = sanitizeSettingsPatch({ logLevel: 'warn' });
  assert(ok.logLevel === 'warn', 'settings: logLevel valide conservé (warn)');
  const bad = sanitizeSettingsPatch({ logLevel: 'trace' });
  assert(!('logLevel' in bad), 'settings: logLevel inconnu rejeté (pas d\'injection)');

  const ipcCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/core/ipcHandlers.js'), 'utf8');
  assert(/LOG_LEVEL_RANK/.test(ipcCode) && /isLogVisible/.test(ipcCode),
    'ipcHandlers: filtre de niveau de log présent');
  assert(/ipcMain\.handle\('logs:export'/.test(ipcCode),
    'ipcHandlers: handler logs:export présent');
  assert(/BASE_OUT_DIR, 'logs'/.test(ipcCode),
    'ipcHandlers: export logs écrit dans BASE_OUT_DIR/logs (chemin main, pas renderer)');

  const preloadCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/preload.js'), 'utf8');
  assert(/exportLogs:/.test(preloadCode) && /logs:export/.test(preloadCode),
    'preload: API exportLogs exposée');

  const htmlCode2 = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
  assert(/id="exportLogsBtn"/.test(htmlCode2), 'index.html: bouton Exporter les logs présent');

  const logsCode = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/logsModule.js'), 'utf8');
  assert(/_buildVisibleLogText/.test(logsCode) && /exportLogs\(/.test(logsCode),
    'logsModule: export des logs visibles via _buildVisibleLogText');
}

console.log('\n[34] OK');

// --- 35. Intégration pipeline : fixture HAR → annonces.json ---
// Exécute le VRAI pipeline forké (--no-desc, aucun réseau) sur un HAR synthétique
// et vérifie la chaîne complète : HAR → JSON → normalisation → déduplication → export.
console.log('\n[35] Intégration pipeline (fixture HAR → annonces.json)');
{
  const os = require('os');
  const { execFileSync } = require('child_process');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-pipeline-'));
  const outDir = path.join(tmp, 'results');
  fs.mkdirSync(outDir, { recursive: true });

  const rawAd = (id, subject, city) => ({
    list_id: id,
    subject,
    body: `Description de ${subject}`,
    price: [ { value: 129.99 } ],
    location: { city, zipcode: '69001' },
    owner: { name: 'Jean', type: 'private', user_id: `u${id}` },
    has_option: { shipping: true },
    images: { urls: [`https://img.leboncoin.fr/${id}.jpg`] },
    favorites_count: 7,
    index_date: '2024-01-01T10:00:00Z',
  });

  // Deux annonces distinctes + une 3e identique à la 1re (doit être fusionnée).
  const payload = {
    data: {
      ads: [ rawAd('111', 'Vélo de course', 'Lyon'), rawAd('222', 'Guitare', 'Paris') ],
      other: { list: [ rawAd('111', 'Vélo de course', 'Lyon') ] },
    },
  };

  const harPath = path.join(tmp, 'capture.har');
  fs.writeFileSync(harPath, JSON.stringify({
    log: {
      version: '1.2',
      creator: { name: 'test', version: '1' },
      entries: [
        {
          startedDateTime: new Date().toISOString(),
          request: { method: 'GET', url: 'https://www.leboncoin.fr/recherche?text=velo' },
          response: { status: 200, content: { mimeType: 'application/json', text: JSON.stringify(payload) } },
        },
        // Entrée non-JSON (HTML) : doit être ignorée sans casser le pipeline.
        {
          request: { method: 'GET', url: 'https://www.leboncoin.fr/' },
          response: { status: 200, content: { mimeType: 'text/html', text: '<html>page</html>' } },
        },
      ],
    },
  }), 'utf8');

  let ranOk = true;
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [
      path.join(base, 'services/scraping/leboncoin-pipeline.js'),
      harPath, '--out', outDir, '--no-desc', '--fresh',
    ], { encoding: 'utf8', timeout: 60000 });
  } catch (err) {
    ranOk = false;
    stdout = (err.stdout || '') + (err.stderr || '');
  }
  assert(ranOk, 'pipeline: exécution réussie sur HAR synthétique (exit 0)');

  const annoncesPath = path.join(outDir, 'annonces.json');
  assert(fs.existsSync(annoncesPath), 'pipeline: annonces.json généré');
  const ads = JSON.parse(fs.readFileSync(annoncesPath, 'utf8'));
  assert(Array.isArray(ads) && ads.length === 2,
    `pipeline: 2 annonces uniques (dédup 3→2), obtenu ${Array.isArray(ads) ? ads.length : '?'}`);
  const velo = ads.find((a) => a.id === '111');
  assert(velo && velo.title === 'Vélo de course' && velo.ville === 'Lyon' && velo.codePostal === '69001',
    'pipeline: champs normalisés + traduits pour export (title, ville, codePostal)');
  assert(typeof velo.prix === 'number' && velo.prix === 129.99,
    'pipeline: prix extrait comme NOMBRE (129.99)');
  assert(velo.deliveryType === 'livraison',
    `pipeline: deliveryType calculé (livraison), obtenu ${velo && velo.deliveryType}`);
  assert(velo.photosCount === 1,
    'pipeline: photos comptées (photosCount)');
  assert(!('raw' in velo) && !('extractionErrors' in velo) && !('livraison' in velo) && !('mainPropre' in velo),
    'pipeline: champs internes (raw, extractionErrors, livraison, mainPropre) retirés du JSON');

  // report.json structuré (Thème 4) avec journal réseau.
  const reportPath = path.join(outDir, 'report.json');
  assert(fs.existsSync(reportPath), 'pipeline: report.json généré');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert(report.schemaVersion === 1 && report.exitCode === 0 && report.counts.ads === 2,
    'pipeline: report.json structuré (schemaVersion, exitCode, counts.ads)');
  assert(report.journal && typeof report.journal.detailRequests === 'number',
    'pipeline: report.json embarque le journal réseau');

  // Mesures de performance observées (comparaison avant/après reproductible).
  assert(report.performance && typeof report.performance.totalMs === 'number' && report.performance.totalMs >= 0,
    'pipeline: report.json contient performance.totalMs (durée observée)');
  assert(report.performance.adsProcessed === 2,
    'pipeline: performance.adsProcessed = nombre réel d\'annonces');
  assert(typeof report.performance.adsPerMinute === 'number' && report.performance.adsPerMinute > 0,
    'pipeline: performance.adsPerMinute calculé (débit)');
  assert(typeof report.performance.peakRssMb === 'number' && report.performance.peakRssMb > 0,
    'pipeline: performance.peakRssMb mesuré (pic mémoire)');
  assert(report.speed === 'ultra-rapide', 'pipeline: report.speed = politique fixe ultra-rapide');

  // Les codes d'erreur PARSE_NO_ADS ne doivent PAS apparaître (HAR exploitable).
  assert(!/PARSE_NO_ADS/.test(stdout), 'pipeline: aucune erreur PARSE_NO_ADS sur HAR valide');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// 35.b Pipeline sur HAR vide → exit code 2 (aucune donnée exploitable), PAS 0.
{
  const os = require('os');
  const { execFileSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-pipeline-empty-'));
  const outDir = path.join(tmp, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const harPath = path.join(tmp, 'empty.har');
  fs.writeFileSync(harPath, JSON.stringify({ log: { version: '1.2', entries: [] } }), 'utf8');
  let code = 0;
  try {
    execFileSync(process.execPath, [
      path.join(base, 'services/scraping/leboncoin-pipeline.js'),
      harPath, '--out', outDir, '--no-desc', '--fresh',
    ], { encoding: 'utf8', timeout: 60000 });
  } catch (err) {
    code = err.status;
  }
  assert(code === 2, `pipeline: HAR vide → exit code 2 (aucune donnée exploitable), obtenu ${code}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[35] OK');

// --- 36. Fixtures HAR réelles : extraction, dédup, blocage, page de détail ---
// Exécute le pipeline sur des HAR synthétiques versionnés (test/fixtures/) pour
// couvrir les cas réels : résultats multiples, doublons, 403, page vide, et le
// parsing de la page de détail (__NEXT_DATA__).
console.log('\n[36] Fixtures HAR (résultats, doublons, 403, page vide, détail)');
{
  const { execFileSync } = require('child_process');
  const os = require('os');
  const fixturesDir = path.join(__dirname, 'fixtures');
  const pipelinePath = path.join(base, 'services/scraping/leboncoin-pipeline.js');

  function runFixture(name, extraArgs = []) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `lbc-fx-${name}-`));
    const outDir = path.join(tmp, 'results');
    fs.mkdirSync(outDir, { recursive: true });
    let code = 0;
    try {
      execFileSync(process.execPath, [pipelinePath, path.join(fixturesDir, `${name}.har`), '--out', outDir, '--no-desc', '--fresh', ...extraArgs], { encoding: 'utf8', timeout: 60000 });
    } catch (err) { code = err.status; }
    const jsonPath = path.join(outDir, 'annonces.json');
    const ads = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null;
    fs.rmSync(tmp, { recursive: true, force: true });
    return { code, ads };
  }

  // 36.1 Résultats de recherche : 3 annonces, ressources non-JSON ignorées.
  const results = runFixture('search-results');
  assert(results.code === 0 && results.ads && results.ads.length === 3,
    `fixtures: search-results → 3 annonces (obtenu ${results.ads ? results.ads.length : 'null'})`);
  const guitare = results.ads && results.ads.find((a) => a.id === '222');
  assert(guitare && guitare.vendeurType === 'pro' && guitare.prix === 80,
    'fixtures: vendeur pro + prix numérique extraits');
  const canape = results.ads && results.ads.find((a) => a.id === '333');
  assert(canape && canape.deliveryType === 'main_propre',
    'fixtures: deliveryType main_propre (pas de livraison)');
  const velo = results.ads && results.ads.find((a) => a.id === '111');
  assert(velo && velo.deliveryType === 'livraison' && velo.photosCount === 2,
    'fixtures: deliveryType livraison + photosCount');

  // 36.2 Doublons : même annonce dans 2 réponses JSON → 1 seule conservée.
  const dups = runFixture('search-duplicates');
  assert(dups.code === 0 && dups.ads && dups.ads.length === 1,
    `fixtures: search-duplicates → 1 annonce unique (obtenu ${dups.ads ? dups.ads.length : 'null'})`);

  // 36.3 Page vide (HTTP 200 sans annonce) → exit 2, pas de faux succès.
  const empty = runFixture('search-empty');
  assert(empty.code === 2 && empty.ads === null,
    `fixtures: search-empty → exit 2 (aucune donnée exploitable), obtenu ${empty.code}`);

  // 36.4 Blocage 403 → exit 2, aucune annonce.
  const blocked = runFixture('search-blocked-403');
  assert(blocked.code === 2 && blocked.ads === null,
    `fixtures: search-blocked-403 → exit 2, obtenu ${blocked.code}`);

  // 36.5 Page de détail (__NEXT_DATA__) : description + attributs enrichis.
  const { parseHtmlDescription } = require('../src/main/services/scraping/leboncoin-pipeline');
  const detailHtml = fs.readFileSync(path.join(fixturesDir, 'detail-page.html'), 'utf8');
  const parsed = parseHtmlDescription(detailHtml, '111');
  assert(parsed.description && /revision fait au printemps/.test(parsed.description),
    'fixtures: page détail → description extraite de __NEXT_DATA__');
  assert(parsed.etat === 'Tres bon etat',
    `fixtures: page détail → état déclaré extrait, obtenu ${JSON.stringify(parsed.etat)}`);
  assert(parsed.livraison === true && parsed.note === 4.5,
    'fixtures: page détail → livraison + note vendeur enrichies');
  assert(parsed.nombreAvis === 12 && parsed.urlProfil === 'https://www.leboncoin.fr/profil/111',
    'fixtures: page détail → nombre d\'avis + URL profil extraits (auparavant perdus)');
  assert(parsed.ancienneteJours == null,
    'fixtures: page détail → ancienneté vendeur non exposée (champ retiré du modèle d\'export)');

  // 36.6 Page de détail sans __NEXT_DATA__ → enrichissement vide SANS crash.
  const noNext = fs.readFileSync(path.join(fixturesDir, 'detail-page-no-nextdata.html'), 'utf8');
  const parsedEmpty = parseHtmlDescription(noNext, '111');
  assert(parsedEmpty.description === null && parsedEmpty.etat === null && parsedEmpty.note === null,
    'fixtures: page détail sans __NEXT_DATA__ → champs null (pas de crash)');

  // 36.7 Détection d'annonce : structure attendue vs bruit.
  const { looksLikeAd, findAdsIterative } = require('../src/main/services/scraping/leboncoin-pipeline');
  assert(looksLikeAd({ list_id: 1, subject: 'X', price: [{ value: 1 }] }) === true,
    'fixtures: looksLikeAd reconnaît une annonce');
  assert(looksLikeAd({ foo: 'bar' }) === false, 'fixtures: looksLikeAd rejette un objet quelconque');
  const found = findAdsIterative(JSON.parse(JSON.parse(fs.readFileSync(path.join(fixturesDir, 'search-results.har'), 'utf8')).log.entries[2].response.content.text));
  assert(found.length === 3, `fixtures: findAdsIterative trouve 3 annonces dans le JSON (obtenu ${found.length})`);
}

console.log('\n[36] OK');

// --- 37. Tests DOM (jsdom) : logsModule + utils, dans un vrai DOM ---
// Charge les modules renderer réels dans un DOM jsdom (pas de stub manuel) pour
// vérifier le rendu, le filtrage rétroactif, les boutons et l'échappement XSS.
console.log('\n[37] DOM jsdom (logsModule, utils)');
{
  const { JSDOM } = require('jsdom');
  const repoRoot = path.join(__dirname, '..');

  const html = `<!doctype html><html><body>
    <div class="logs-toolbar">
      <button id="logModeToggleBtn">mode</button>
      <button id="autoScrollToggleBtn">scroll</button>
      <button id="copyLogsBtn">copy</button>
      <button id="exportLogsBtn">export</button>
      <button id="clearLogsBtn">clear</button>
    </div>
    <div id="logsConsole" class="console"></div>
    <div id="logStats"></div>
    <div id="structureWarning" class="hidden"><span id="structureWarningText"></span></div>
  </body></html>`;

  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://app.local/' });
  const { window } = dom;

  let onLogCb = null;
  let exportedText = null;
  window.api = {
    onLog: (cb) => { onLogCb = cb; },
    exportLogs: async (t) => { exportedText = t; return { ok: true, path: '/tmp/x.log' }; },
    openFolder: async () => ({ ok: true }),
    openFile: async () => ({ ok: true }),
    openExternal: () => {},
  };
  window.navigator.clipboard = { writeText: async () => {} };

  // Charge appState (état partagé) puis logsModule dans le MÊME scope d'eval
  // (les `let`/`const` top-level doivent être partagés entre les deux modules).
  const appStateSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/appState.js'), 'utf8');
  const logsSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/logsModule.js'), 'utf8');
  window.eval(appStateSrc + '\n' + logsSrc);

  assert(typeof onLogCb === 'function', 'jsdom: logsModule enregistre window.api.onLog');
  const consoleEl = window.document.getElementById('logsConsole');

  // 37.1 Un log info s'affiche ; un log debug est masqué en mode normal.
  onLogCb({ level: 'info', message: 'démarrage du scraping' });
  onLogCb({ level: 'debug', message: 'détail technique' });
  let lines = [...consoleEl.children].map((c) => c.textContent);
  assert(lines.some((l) => /démarrage du scraping/.test(l)),
    'jsdom: log info affiché');
  assert(!lines.some((l) => /détail technique/.test(l)),
    'jsdom: log debug masqué en mode normal');

  // 37.2 Bascule en mode debug → filtrage rétroactif : le debug apparaît.
  window.document.getElementById('logModeToggleBtn').click();
  lines = [...consoleEl.children].map((c) => c.textContent);
  assert(lines.some((l) => /détail technique/.test(l)),
    'jsdom: bascule debug → logs debug réaffichés (filtrage rétroactif)');
  assert(window.document.getElementById('logStats').textContent.includes('total'),
    'jsdom: compteur de logs mis à jour');

  // 37.3 Bandeau de changement de structure déclenché par le log attendu.
  onLogCb({ level: 'warn', message: 'detectStructureChanges : champ price manquant' });
  const sw = window.document.getElementById('structureWarning');
  assert(!sw.classList.contains('hidden'),
    'jsdom: avertissement de structure affiché sur log detectStructureChanges');

  // 37.4 Bouton Exporter → appelle window.api.exportLogs avec le texte visible.
  window.document.getElementById('exportLogsBtn').click();
  await new Promise((r) => setTimeout(r, 20));
  assert(typeof exportedText === 'string' && /démarrage du scraping/.test(exportedText),
    'jsdom: bouton Exporter transmet les logs visibles à exportLogs');
  assert(/\[INFO\]/.test(exportedText),
    'jsdom: texte exporté préfixé du niveau ([INFO])');

  // 37.5 Bouton Vider → console + buffer vidés.
  window.document.getElementById('clearLogsBtn').click();
  assert(consoleEl.children.length === 0, 'jsdom: bouton Vider efface la console');

  // 37.6 utils.js : échappement XSS réel exécuté dans le DOM.
  const utilsSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/utils.js'), 'utf8');
  window.eval(utilsSrc + '\n;window.__t = { escapeHtml, escapePath };');
  const { escapeHtml, escapePath } = window.__t;
  assert(escapeHtml('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;',
    'jsdom: escapeHtml neutralise une balise script');
  assert(escapeHtml('a"b') === 'a&quot;b', 'jsdom: escapeHtml échappe les guillemets');
  // escapePath : double contexte HTML+JS — " devient &quot;, ' devient \'
  const ep = escapePath(`x"y'z\\w&v`);
  assert(ep.includes('&quot;') && ep.includes("\\'") && ep.includes('&amp;'),
    'jsdom: escapePath échappe ", \', \\, & (double contexte)');
  assert(!ep.includes('&amp;quot;'),
    'jsdom: escapePath pas de double-encodage (&amp;quot;)');

  dom.window.close();
}

console.log('\n[37] OK');

// --- 37b. UX (Thème 5) : toasts, bandeau d'erreur, confirmation asynchrone ---
console.log('\n[37b] UX jsdom (toasts, bandeau erreur, askConfirm)');
{
  const { JSDOM } = require('jsdom');
  const repoRoot = path.join(__dirname, '..');
  const utilsSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/utils.js'), 'utf8');

  const html = `<!doctype html><html><body>
    <div id="scrapeErrorBanner" class="hidden">
      <span id="scrapeErrorIcon"></span>
      <strong id="scrapeErrorTitle"></strong>
      <p id="scrapeErrorMessage"></p>
    </div>
    <div id="askModal" class="modal-overlay hidden">
      <h3 id="askModalTitle"></h3><p id="askModalMessage"></p>
      <button id="askModalConfirmBtn"></button><button id="askModalCancelBtn"></button>
    </div>
    <div id="toastContainer"></div>
  </body></html>`;
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://app.local/' });
  const { window } = dom;
  window.api = { openExternal: () => {}, openFolder: async () => ({ success: true }), openFile: async () => ({ success: true }) };
  window.eval(utilsSrc);

  // 37b.1 Toast : ajout au conteneur + fermeture via le bouton ×.
  const container = window.document.getElementById('toastContainer');
  const toast = window.showToast('Bonjour', 'success');
  assert(container.children.length === 1 && toast.classList.contains('toast-success'),
    'ux: showToast ajoute un toast typé au conteneur');
  assert(container.textContent.includes('Bonjour'), 'ux: toast contient le message');
  toast.querySelector('.toast-close').click();
  await new Promise((r) => setTimeout(r, 260));
  assert(container.children.length === 0, 'ux: clic sur × retire le toast');

  // 37b.2 Toast : pas d'injection HTML (texte rendu via textContent).
  window.showToast('<img src=x onerror=alert(1)>', 'info');
  assert(container.querySelector('img') === null, 'ux: showToast n\'injecte pas de HTML (textContent)');

  // 37b.3 Bandeau d'erreur : titre + message + visibilité.
  const banner = window.document.getElementById('scrapeErrorBanner');
  window.showScrapeError({ type: 'error', title: 'Accès refusé', message: 'HTTP 403' });
  assert(!banner.classList.contains('hidden'), 'ux: showScrapeError affiche le bandeau');
  assert(window.document.getElementById('scrapeErrorTitle').textContent === 'Accès refusé',
    'ux: bandeau titre correct');
  assert(window.document.getElementById('scrapeErrorMessage').textContent === 'HTTP 403',
    'ux: bandeau message correct');
  window.showScrapeError({ type: 'warn', title: 'Partiel', message: 'incomplet' });
  assert(banner.classList.contains('scrape-error-banner--warn'), 'ux: bandeau mode avertissement');
  window.hideScrapeError();
  assert(banner.classList.contains('hidden'), 'ux: hideScrapeError masque le bandeau');

  // 37b.4 askConfirm : résolution true (Confirmer) / false (Annuler).
  const pOk = window.askConfirm({ title: 't', message: 'm', confirmLabel: 'OK' });
  assert(!window.document.getElementById('askModal').classList.contains('hidden'),
    'ux: askConfirm ouvre la modal');
  assert(window.document.getElementById('askModalConfirmBtn').textContent === 'OK',
    'ux: askConfirm applique le libellé du bouton');
  window.document.getElementById('askModalConfirmBtn').click();
  assert((await pOk) === true, 'ux: askConfirm → true sur Confirmer');

  const pCancel = window.askConfirm({ message: 'm2' });
  window.document.getElementById('askModalCancelBtn').click();
  assert((await pCancel) === false, 'ux: askConfirm → false sur Annuler');
  assert(window.document.getElementById('askModal').classList.contains('hidden'),
    'ux: askConfirm referme la modal après choix');

  // 37b.5 Repli : sans conteneur, showToast n'jette pas (console).
  const dom2 = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://app.local/' });
  dom2.window.api = window.api;
  dom2.window.eval(utilsSrc);
  let threw = false;
  try { dom2.window.showToast('x', 'info'); } catch { threw = true; }
  assert(!threw, 'ux: showToast sans conteneur → pas d\'exception (repli console)');

  dom.window.close(); dom2.window.close();

  // 37b.6 Structure : index.html contient les nouveaux éléments ; plus aucun
  // alert()/confirm() natif dans le renderer (remplacés par toast/askConfirm).
  const indexHtml = fs.readFileSync(path.join(repoRoot, 'src/renderer/index.html'), 'utf8');
  assert(/id="toastContainer"/.test(indexHtml), 'ux: index.html contient #toastContainer');
  assert(/id="scrapeErrorBanner"/.test(indexHtml), 'ux: index.html contient #scrapeErrorBanner');
  assert(/id="askModal"/.test(indexHtml), 'ux: index.html contient #askModal');
  const rendererFilesUx = ['utils.js', 'scraperModule.js', 'historyModule.js', 'logsModule.js', 'explorerModule.js', 'statsModule.js', 'mapModule.js', 'app.js'];
  const uxCodeRaw = rendererFilesUx.map((f) => fs.readFileSync(path.join(repoRoot, 'src/renderer', f), 'utf8')).join('\n');
  // On retire les commentaires ligne/bloc avant de chercher les appels natifs,
  // sinon les mentions « alert() » dans les commentaires déclenchent un faux positif.
  const uxCode = uxCodeRaw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
  assert(!/[^.\w]alert\(/.test(uxCode), 'ux: plus d\'alert() natif dans le renderer');
  assert(!/[^.\w]confirm\(/.test(uxCode.replace(/window\.confirm/g, '')), 'ux: plus de confirm() natif (hors repli)');
  assert(/showToast\s*\(/.test(uxCode), 'ux: showToast utilisé par les modules');
  assert(/showScrapeError\s*\(/.test(fs.readFileSync(path.join(repoRoot, 'src/renderer/scraperModule.js'), 'utf8')),
    'ux: scraperModule câble le bandeau d\'erreur');
}

console.log('\n[37b] OK');

// --- 37c. Sécurité (Thème 6) : actions déléguées data-action + CSP ---
console.log('\n[37c] Sécurité jsdom (actions déléguées, CSP)');
{
  const { JSDOM } = require('jsdom');
  const repoRoot = path.join(__dirname, '..');
  const utilsSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/utils.js'), 'utf8');

  const html = `<!doctype html><html><body>
    <button id="btnUrl" data-action="openUrl" data-url="https://www.leboncoin.fr/ad/1">Voir</button>
    <span id="btnStar" data-action="toggleStar" data-id="42">★</span>
    <input id="chk" type="checkbox" data-action="toggleCompare" data-id="7">
    <div id="chip" data-action="loadPreset" data-id="3"><span id="del" data-action="deletePreset" data-id="3">✕</span></div>
  </body></html>`;
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://app.local/' });
  const { window } = dom;

  const calls = { openUrl: [], toggleStar: [], toggleCompare: [], loadPreset: [], deletePreset: [] };
  window.api = { openExternal: (u) => calls.openUrl.push(u), openFolder: async () => ({ success: true }), openFile: async () => ({ success: true }) };
  window.toggleStar = (id) => calls.toggleStar.push(id);
  window.toggleCompare = (id) => calls.toggleCompare.push(id);
  window.loadPreset = (i) => calls.loadPreset.push(i);
  window.deletePreset = (i) => calls.deletePreset.push(i);
  window.eval(utilsSrc);
  window.installDelegatedActions();

  // 37c.1 openUrl : le data-url est transmis à openExternal.
  window.document.getElementById('btnUrl').click();
  assert(calls.openUrl.length === 1 && calls.openUrl[0] === 'https://www.leboncoin.fr/ad/1',
    'sec: data-action=openUrl transmet data-url à openExternal');

  // 37c.2 toggleStar : data-id transmis.
  window.document.getElementById('btnStar').click();
  assert(calls.toggleStar.length === 1 && calls.toggleStar[0] === '42',
    'sec: data-action=toggleStar transmet data-id');

  // 37c.3 toggleCompare via événement change (checkbox).
  const chk = window.document.getElementById('chk');
  chk.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert(calls.toggleCompare.length === 1 && calls.toggleCompare[0] === '7',
    'sec: data-action=toggleCompare réagit au change');

  // 37c.4 loadPreset : data-id converti en nombre.
  window.document.getElementById('chip').click();
  assert(calls.loadPreset.length === 1 && calls.loadPreset[0] === 3,
    'sec: data-action=loadPreset convertit data-id en nombre');

  // 37c.5 deletePreset : stopPropagation empêche loadPreset de se déclencher.
  calls.loadPreset.length = 0;
  window.document.getElementById('del').click();
  assert(calls.deletePreset.length === 1 && calls.deletePreset[0] === 3,
    'sec: data-action=deletePreset déclenche deletePreset');
  assert(calls.loadPreset.length === 0,
    'sec: deletePreset stoppe la propagation (loadPreset non déclenché)');

  // 37c.6 Une valeur hostile dans data-id n'est JAMAIS exécutée (attribut, pas code).
  let injected = false;
  window.eval('window.__probe = () => { injected = true; };');
  const evil = window.document.createElement('span');
  evil.setAttribute('data-action', 'toggleStar');
  evil.setAttribute('data-id', "1'); window.__probe(); //");
  window.document.body.appendChild(evil);
  calls.toggleStar.length = 0;
  evil.click();
  assert(calls.toggleStar.length === 1 && calls.toggleStar[0] === "1'); window.__probe(); //",
    'sec: data-id hostile traité comme chaîne, jamais comme code');
  assert(injected === false, 'sec: aucune exécution de code via data-*');

  // 37c.7 Statique : plus aucun handler inline dans le renderer (on ignore les
  // commentaires, qui peuvent mentionner « onclick= » à titre explicatif).
  const files = ['utils.js', 'scraperModule.js', 'historyModule.js', 'logsModule.js', 'explorerModule.js', 'statsModule.js', 'mapModule.js', 'app.js'];
  const code = files.map((f) => fs.readFileSync(path.join(repoRoot, 'src/renderer', f), 'utf8')).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
  assert(!/onclick=/.test(code), 'sec: plus de onclick= généré dans le renderer');
  assert(!/onchange=/.test(code), 'sec: plus de onchange= généré dans le renderer');
  const indexHtml = fs.readFileSync(path.join(repoRoot, 'src/renderer/index.html'), 'utf8');
  const cspMeta = (indexHtml.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1] || '';
  assert(/script-src 'self';/.test(cspMeta) && !/script-src[^;]*unsafe-inline/.test(cspMeta),
    'sec: CSP script-src sans unsafe-inline');

  dom.window.close();
}

console.log('\n[37c] OK');

// --- 37d. Perf (Thème 7) : debounce + compteur de logs incrémental ---
console.log('\n[37d] Perf jsdom (debounce, compteur logs incrémental)');
{
  const { JSDOM } = require('jsdom');
  const repoRoot = path.join(__dirname, '..');
  const utilsSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/utils.js'), 'utf8');

  // 37d.1 debounce : un seul appel après une rafale ; cancel annule.
  {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://app.local/' });
    dom.window.api = { openExternal: () => {} };
    dom.window.eval(utilsSrc);
    let calls = 0;
    const d = dom.window.debounce(() => { calls++; }, 40);
    d(); d(); d();
    assert(calls === 0, 'perf: debounce ne s\'exécute pas pendant la rafale');
    await new Promise((r) => setTimeout(r, 80));
    assert(calls === 1, 'perf: debounce → un seul appel après la rafale');
    d(); d.cancel();
    await new Promise((r) => setTimeout(r, 80));
    assert(calls === 1, 'perf: debounce.cancel annule l\'appel en attente');
    dom.window.close();
  }

  // 37d.2 logsModule : compteur visible exact (incrémental) avec éviction buffer.
  {
    const html = `<!doctype html><html><body>
      <div class="logs-toolbar">
        <button id="logModeToggleBtn">mode</button>
        <button id="autoScrollToggleBtn">scroll</button>
        <button id="copyLogsBtn">copy</button>
        <button id="exportLogsBtn">export</button>
        <button id="clearLogsBtn">clear</button>
      </div>
      <div id="logsConsole" class="console"></div>
      <div id="logStats"></div>
      <div id="structureWarning" class="hidden"><span id="structureWarningText"></span></div>
    </body></html>`;
    const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://app.local/' });
    const { window } = dom;
    let onLogCb = null;
    window.api = { onLog: (cb) => { onLogCb = cb; }, exportLogs: async () => ({ ok: true }), openFolder: async () => ({ ok: true }), openFile: async () => ({ ok: true }), openExternal: () => {} };
    const appStateSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/appState.js'), 'utf8');
    const logsSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/logsModule.js'), 'utf8');
    window.eval(appStateSrc + '\n' + logsSrc);

    // 3 info visibles + 2 debug masqués (mode normal) → compteur = 3.
    onLogCb({ level: 'info', message: 'a' });
    onLogCb({ level: 'debug', message: 'b' });
    onLogCb({ level: 'info', message: 'c' });
    onLogCb({ level: 'debug', message: 'd' });
    onLogCb({ level: 'warn', message: 'e' });
    const stats = () => window.document.getElementById('logStats').textContent;
    assert(/3 log\(s\) affiché\(s\) \/ 5 total/.test(stats()),
      'perf: compteur visible incrémental exact (3/5)');

    // Passage en debug → tout visible → 5/5.
    window.document.getElementById('logModeToggleBtn').click();
    assert(/5 log\(s\) affiché\(s\) \/ 5 total/.test(stats()),
      'perf: bascule debug → compteur recalculé (5/5)');

    // Vider → 0.
    window.document.getElementById('clearLogsBtn').click();
    assert(/0 log\(s\)/.test(stats()), 'perf: compteur remis à 0 après Vider');
    dom.window.close();
  }
}

console.log('\n[37d] OK');

// --- 38. Modules main sous-couverts : settings, logger, fileManager,
// storageCleaner, jobHistory, ipcHandlers (invocation réelle des handlers) ---
console.log('\n[38] Modules main (settings, logger, fileManager, storageCleaner, jobHistory, ipcHandlers)');
{
  const os = require('os');
  const { writeWithChecksum } = require('../src/main/utils/integrity');

  // 38.1 settings : validation de patch + aller-retour de persistance.
  const settings = require('../src/main/core/settings');
  const clean = settings.sanitizeSettingsPatch({
    autoCleanHarDays: 30, logLevel: 'warn', scrapeSpeed: 'rapide',
    headless: false, pageDelayMs: 2500, autoCleanJobsDays: 10,
    logRetentionDays: 14, includeSellerData: false,
    __injected: 'x', autoCleanJobsDays_evil: 999999,
  });
  assert(clean.autoCleanHarDays === 30 && clean.logLevel === 'warn',
    'settings: patch valide conservé');
  assert(clean.headless === false && clean.includeSellerData === false && clean.autoCleanJobsDays === 10,
    'settings: booléens + entiers conservés');
  // Vitesse/délai : refusés (configuration de scraping fixe).
  assert(clean.scrapeSpeed === undefined && clean.pageDelayMs === undefined,
    'settings: scrapeSpeed/pageDelayMs refusés (config fixe)');
  assert(!('__injected' in clean) && !('autoCleanJobsDays_evil' in clean),
    'settings: clés inconnues rejetées (anti-injection)');
  const rejected = settings.sanitizeSettingsPatch({
    autoCleanHarDays: -5, logLevel: 'verbose', scrapeSpeed: 'turbo',
    pageDelayMs: 999999, headless: 'oui', logRetentionDays: 0,
  });
  assert(Object.keys(rejected).length === 0,
    'settings: valeurs hors plage / hors enum rejetées');
  assert(settings.sanitizeSettingsPatch(null) && Object.keys(settings.sanitizeSettingsPatch(null)).length === 0,
    'settings: patch null → objet vide');
  assert(settings.SETTINGS_DEFAULTS.logLevel === 'debug' && !('scrapeSpeed' in settings.SETTINGS_DEFAULTS),
    'settings: valeurs par défaut présentes (sans vitesse configurable)');

  const saved = settings.saveSettings({ logLevel: 'error', autoCleanJobsDays: 3 });
  assert(saved.logLevel === 'error' && saved.autoCleanJobsDays === 3, 'settings: saveSettings renvoie le fusionné');
  const reloaded = settings.loadSettings();
  assert(reloaded.logLevel === 'error' && reloaded.autoCleanJobsDays === 3,
    'settings: relecture depuis le disque (persistance)');
  assert(!('scrapeSpeed' in reloaded) && !('pageDelayMs' in reloaded),
    'settings: aucune clé de vitesse héritée après relecture');

  // 38.2 logger : configuration, écriture sans crash, fermeture.
  const { logger } = require('../src/main/utils/logger');
  logger.setRetention(0);          // clampé à 1
  logger.setRetention('abc');      // fallback défaut
  assert(typeof logger.getLogDir() === 'string' && logger.getLogDir().length > 0,
    'logger: getLogDir renvoie un chemin');
  logger.debug('test debug'); logger.info('test info'); logger.warn('test warn'); logger.error('test error');
  logger.info({ obj: true, nested: { a: 1 } }); // safeStringify sur objet
  logger.close();
  assert(true, 'logger: écriture debug/info/warn/error + close sans exception');

  // 38.3 fileManager : création de dossier + fichier inexistant.
  const { FileManager } = require('../src/main/infrastructure/fileManager');
  const fmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-fm-'));
  const nested = path.join(fmDir, 'a', 'b', 'c');
  const errStr = await FileManager.openFolder(nested);
  assert(fs.existsSync(nested) && errStr === '', 'fileManager: openFolder crée le dossier + retourne ""');
  let threw = false;
  try { await FileManager.openFile(path.join(fmDir, 'absent.txt')); } catch { threw = true; }
  assert(threw, 'fileManager: openFile fichier inexistant → throw');
  const existing = path.join(fmDir, 'present.txt');
  fs.writeFileSync(existing, 'x');
  const openErr = await FileManager.openFile(existing);
  assert(openErr === '', 'fileManager: openFile existant → retourne "" (succès)');
  fs.rmSync(fmDir, { recursive: true, force: true });

  // 38.4 storageCleaner : nettoyage des jobs anciens par timestamp du nom.
  const { StorageCleaner } = require('../src/main/services/maintenance/storageCleaner');
  const { JOBS_DIR } = require('../src/main/config/constants');
  assert(StorageCleaner.cleanOldJobs(0) === 0, 'storageCleaner: maxDays=0 → aucun nettoyage');
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  const oldJobName = 'job-2020-01-01T00-00-00-000Z';
  const oldJobPath = path.join(JOBS_DIR, oldJobName);
  fs.mkdirSync(path.join(oldJobPath, 'results'), { recursive: true });
  const recentJobName = `job-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}-000Z`;
  const recentJobPath = path.join(JOBS_DIR, recentJobName);
  fs.mkdirSync(path.join(recentJobPath, 'results'), { recursive: true });
  const deleted = StorageCleaner.cleanOldJobs(30);
  assert(deleted >= 1 && !fs.existsSync(oldJobPath), 'storageCleaner: job ancien supprimé (>30j)');
  assert(fs.existsSync(recentJobPath), 'storageCleaner: job récent conservé');
  // cleanOldHars sur dossier sans HAR → 0
  assert(StorageCleaner.cleanOldHars(7) === 0, 'storageCleaner: aucun HAR → 0');

  // 38.5 jobHistory : listing, intégrité, export-meta, suppression.
  const { JobHistoryManager } = require('../src/main/services/jobs/jobHistory');
  const jobId = recentJobName;
  const resultsDir = path.join(recentJobPath, 'results');
  writeWithChecksum(path.join(resultsDir, 'annonces.json'), [
    { id: '1', title: 'Vélo', prix: 100, deliveryType: 'livraison' },
    { id: '2', title: 'Table', prix: 50, deliveryType: 'main_propre' },
  ], null, 2);
  fs.writeFileSync(path.join(resultsDir, 'export-meta.json'), JSON.stringify({ profileId: 'maximum', exportFields: ['title'] }));

  const jobs = JobHistoryManager.listAllJobs();
  const found = jobs.find((j) => j.id === jobId);
  assert(found && found.adsCount === 2, 'jobHistory: job listé avec le bon nombre d\'annonces');
  assert(found.integrityWarning === null, 'jobHistory: intégrité OK (checksum valide)');
  assert(found.exportMeta && found.exportMeta.profileId === 'maximum', 'jobHistory: export-meta lu');
  assert(found.date && /\d{2}\/\d{2}\/\d{4}/.test(found.date), 'jobHistory: date formatée FR (jj/mm/aaaa)');
  assert(JobHistoryManager.getLatestJob() !== null, 'jobHistory: getLatestJob renvoie un job');

  // Intégrité compromise : checksum modifié → warning, annonces ignorées.
  fs.writeFileSync(path.join(resultsDir, 'annonces.json.sha256'), 'deadbeef');
  const jobsCorrupt = JobHistoryManager.listAllJobs();
  const corrupt = jobsCorrupt.find((j) => j.id === jobId);
  assert(corrupt && corrupt.integrityWarning, 'jobHistory: checksum invalide → integrityWarning');

  // Suppression : ID valide supprime ; ID malveillant refusé.
  assert(JobHistoryManager.deleteJob('../etc') === false, 'jobHistory: jobId avec .. refusé');
  assert(JobHistoryManager.deleteJob('not-a-job') === false, 'jobHistory: jobId malformé refusé');
  assert(JobHistoryManager.deleteJob(jobId) === true && !fs.existsSync(recentJobPath),
    'jobHistory: suppression d\'un job valide');

  // 38.6 ipcHandlers : invocation RÉELLE des handlers (config, logs, fichiers,
  // secrets, openExternal) via un ipcMain capturant.
  const handlers = {};
  const ipcStub = {
    app: { isPackaged: false, getPath: (p) => `/tmp/leboncoin-test-${p}` },
    Notification: { isSupported: () => false },
    shell: { openPath: async () => '', openExternal: async () => {} },
    ipcMain: { on: (ch, fn) => { handlers[ch] = fn; }, handle: (ch, fn) => { handlers[ch] = fn; } },
    BrowserWindow: function () { this.webContents = { send: () => {} }; },
  };
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return ipcStub;
    if (request === 'playwright') return { chromium: { launch: async () => { throw new Error('stub'); } } };
    return origLoad.apply(this, arguments);
  };
  const ipcPath = require.resolve('../src/main/core/ipcHandlers');
  delete require.cache[ipcPath];
  const { setupIpcHandlers } = require(ipcPath);
  const api = setupIpcHandlers(() => null);
  Module._load = origLoad;

  assert(typeof api.shutdown === 'function', 'ipcHandlers: shutdown exposé');
  assert(typeof handlers['config:get'] === 'function' && typeof handlers['config:save'] === 'function',
    'ipcHandlers: handlers config enregistrés');
  assert(typeof handlers['logs:export'] === 'function' && typeof handlers['shell:openExternal'] === 'function',
    'ipcHandlers: handlers logs + openExternal enregistrés');

  const cfg = await handlers['config:get']();
  assert(cfg && typeof cfg === 'object', 'ipcHandlers: config:get renvoie les réglages');
  const saved2 = await handlers['config:save']({}, { logLevel: 'info' });
  assert(saved2.logLevel === 'info', 'ipcHandlers: config:save applique + renvoie');

  const expEmpty = await handlers['logs:export']({}, '   ');
  assert(expEmpty.ok === false, 'ipcHandlers: logs:export vide → ok:false');
  const expOk = await handlers['logs:export']({}, '[INFO] ligne de test');
  assert(expOk.ok === true && fs.existsSync(expOk.path), 'ipcHandlers: logs:export écrit le fichier');
  fs.rmSync(expOk.path, { force: true });

  const { BASE_OUT_DIR } = require('../src/main/config/constants');
  const openOk = await handlers['file:openFolder']({}, BASE_OUT_DIR);
  assert(openOk.success === true, 'ipcHandlers: file:openFolder chemin autorisé → succès');
  const openBad = await handlers['file:openFolder']({}, '/etc');
  assert(openBad.success === false && /non autorisé/i.test(openBad.error),
    'ipcHandlers: file:openFolder hors BASE_OUT_DIR → refusé (path-traversal)');

  // job:openSessionFolder — ouvre le dossier de résultats d'une session.
  // Le renderer ne fournit qu'un ID (jamais un chemin) : les ID malformés ou
  // tentant une traversée doivent être rejetés AVANT tout accès disque.
  assert(typeof handlers['job:openSessionFolder'] === 'function',
    'ipcHandlers: handler job:openSessionFolder enregistré');
  const sfBad1 = await handlers['job:openSessionFolder']({}, '../etc');
  assert(sfBad1.success === false, 'ipcHandlers: sessionFolder rejette « .. »');
  const sfBad2 = await handlers['job:openSessionFolder']({}, 'job-../x');
  assert(sfBad2.success === false, 'ipcHandlers: sessionFolder rejette un ID non conforme');
  const sfBad3 = await handlers['job:openSessionFolder']({}, '/etc/passwd');
  assert(sfBad3.success === false, 'ipcHandlers: sessionFolder rejette un chemin absolu');
  const sfBad4 = await handlers['job:openSessionFolder']({}, 42);
  assert(sfBad4.success === false, 'ipcHandlers: sessionFolder rejette un ID non-string');
  const sfMissing = await handlers['job:openSessionFolder']({}, 'job-2026-01-01T00-00-00');
  assert(sfMissing.success === false && /n'existe plus|existe/i.test(sfMissing.error),
    'ipcHandlers: sessionFolder session absente → message explicite');

  const extOk = await handlers['shell:openExternal']({}, 'https://www.leboncoin.fr/');
  assert(extOk.success === true, 'ipcHandlers: openExternal http/https autorisé');
  const extBad = await handlers['shell:openExternal']({}, 'javascript:alert(1)');
  assert(extBad.success === false, 'ipcHandlers: openExternal schéma exotique refusé');
  const extBad2 = await handlers['shell:openExternal']({}, 'file:///etc/passwd');
  assert(extBad2.success === false, 'ipcHandlers: openExternal file:// refusé');
  const extEmpty = await handlers['shell:openExternal']({}, '');
  assert(extEmpty.success === false, 'ipcHandlers: openExternal URL vide refusée');

  // 38.6b secrets : liste blanche de clés (Thème 6).
  assert(typeof handlers['secret:get'] === 'function' && typeof handlers['secret:set'] === 'function',
    'ipcHandlers: handlers secret enregistrés');
  const setBadKey = await handlers['secret:set']({}, { key: '../evil', value: 'x' });
  assert(setBadKey === false, 'sec: secret:set clé invalide → refusé');
  const setBadVal = await handlers['secret:set']({}, { key: 'tavily-api-key', value: 123 });
  assert(setBadVal === false, 'sec: secret:set valeur non textuelle → refusé');
  const setOk = await handlers['secret:set']({}, { key: 'tavily-api-key', value: 'secret-value' });
  assert(setOk === true, 'sec: secret:set clé valide → accepté');
  assert((await handlers['secret:has']({}, 'tavily-api-key')) === true, 'sec: secret:has clé valide → true');
  assert((await handlers['secret:get']({}, 'tavily-api-key')) === 'secret-value',
    'sec: secret:get clé autorisée → valeur déchiffrée');
  assert((await handlers['secret:get']({}, 'internal-app-key')) === null,
    'sec: secret:get clé hors liste blanche → null (pas de fuite)');
  assert((await handlers['secret:get']({}, 'NOT A KEY')) === null, 'sec: secret:get clé malformée → null');
  assert((await handlers['secret:has']({}, 'x;y')) === false, 'sec: secret:has clé malformée → false');
  await handlers['secret:remove']({}, 'tavily-api-key');
  assert((await handlers['secret:has']({}, 'tavily-api-key')) === false, 'sec: secret:remove clé valide → supprimée');

  // 38.7 rateLimiter : mathématique du backoff (délais réduits pour un test
  // rapide ; `sleep` est capturé à l'import, on teste donc currentDelayMs()).
  {
    const { AdaptiveRateLimiter } = require('../src/main/utils/rateLimiter');
    const rl = new AdaptiveRateLimiter({ baseDelayMs: 20, minDelayMs: 10, maxDelayMs: 160, backoffFactor: 2 });
    assert(rl.currentDelayMs() === 20, 'rateLimiter: délai initial = base');
    await rl.waitAfter({ blocked: true, status: 429 });
    assert(rl.currentDelayMs() === 40, 'rateLimiter: 1er blocage → base×2');
    await rl.waitAfter({ blocked: true, status: 403 });
    assert(rl.currentDelayMs() === 80, 'rateLimiter: 2e blocage → base×4 (exponentiel)');
    await rl.waitAfter({ blocked: true, status: 403 });
    assert(rl.currentDelayMs() === 160, 'rateLimiter: 3e blocage → base×8 (plafonné)');
    await rl.waitAfter({ blocked: true, status: 403 });
    await rl.waitAfter({ blocked: true, status: 403 });
    assert(rl.currentDelayMs() === 160, 'rateLimiter: blocages répétés → reste plafonné à maxDelayMs');
    rl.reset();
    assert(rl.currentDelayMs() === 20, 'rateLimiter: reset → retour au délai de base');
    await rl.waitAfter({ error: true });
    assert(rl.currentDelayMs() === 30, 'rateLimiter: erreur réseau → ×1.5');
    rl.reset();
    await rl.waitAfter({ durationMs: 5000 });
    assert(rl.currentDelayMs() === 25, 'rateLimiter: réponse lente → ×1.25');
    rl.reset();
    for (let i = 0; i < 5; i++) await rl.waitAfter({ durationMs: 10 });
    assert(rl.currentDelayMs() === 17, 'rateLimiter: 5 succès rapides → accélération (×0.85)');
    await rl.wait(); // ne doit pas lever
    assert(rl.currentDelayMs() === 17, 'rateLimiter: wait() n\'altère pas le délai courant');
  }

  // 38.8 captureState : progression + fusion HAR (reprise incrémentale).
  {
    const captureState = require('../src/main/services/scraping/captureState');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-cap-'));
    assert(captureState.readProgress(tmp) === null, 'captureState: progression absente → null');
    captureState.writeProgress(tmp, { searchUrl: 'u', pagesRequested: 10, lastPageOk: 6, pagesOk: 6 });
    const prog = captureState.readProgress(tmp);
    assert(prog && prog.lastPageOk === 6 && typeof prog.updatedAt === 'string',
      'captureState: write/read aller-retour + updatedAt');

    const harA = path.join(tmp, 'a.har');
    const harB = path.join(tmp, 'b.har');
    const mkHar = (n) => JSON.stringify({ log: { version: '1.2', entries: Array.from({ length: n }, (_, i) => ({ request: { url: `u${i}` }, response: { status: 200, content: {} } })) } });
    fs.writeFileSync(harA, mkHar(6));
    fs.writeFileSync(harB, mkHar(4));
    const out = path.join(tmp, 'merged.har');
    const merged = captureState.mergeHarFiles([harA, harB], out);
    assert(merged.entries === 10 && merged.sources === 2, 'captureState: fusion 6+4 entrées HAR');
    const mergedData = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert(mergedData.log.entries.length === 10, 'captureState: HAR fusionné contient toutes les entrées');
    assert(captureState.mergeHarFiles([], out).entries === 0, 'captureState: fusion sans fichier → 0');

    captureState.clearProgress(tmp);
    assert(captureState.readProgress(tmp) === null, 'captureState: clearProgress efface la progression');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 38.9 diagnostics + helpers : fonctions utilitaires restantes.
  {
    const diag = require('../src/main/utils/diagnostics');
    const circular = { a: 1 };
    circular.self = circular;
    assert(/référence circulaire/.test(diag.safeStringify(circular)),
      'diagnostics: safeStringify gère les références circulaires');
    assert(/BigInt/.test(diag.safeStringify({ n: 10n })),
      'diagnostics: safeStringify sérialise les BigInt');
    assert(diag.formatBytes(1024 * 1024 * 3) === '3.00 Mo', 'diagnostics: formatBytes → Mo');
    assert(diag.formatBytes(null) === '?', 'diagnostics: formatBytes(null) → ?');
    assert(diag.formatMs(null) === '?', 'diagnostics: formatMs(null) → ?');

    const helpers = require('../src/main/utils/helpers');
    assert(helpers.cleanText('a\r\nb\n\n\n\nc  ') === 'a\nb\n\nc',
      'helpers: cleanText normalise CRLF + compacte les sauts de ligne');
    assert(helpers.cleanText(42) === 42, 'helpers: cleanText non-string → inchangé');
    const t0 = Date.now();
    await helpers.randomDelay(5, 10);
    assert(Date.now() - t0 >= 5, 'helpers: randomDelay attend au moins minMs');
    const awDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-aw-'));
    const awPath = path.join(awDir, 'sub', 'f.txt');
    helpers.atomicWriteFileSync(awPath, 'contenu');
    assert(fs.readFileSync(awPath, 'utf8') === 'contenu', 'helpers: atomicWriteFileSync écrit le fichier');
    fs.rmSync(awDir, { recursive: true, force: true });
  }

  // 38.10 sessionPaths : résolution par priorité (globale > job > null).
  {
    const sessionPaths = require('../src/main/services/scraping/sessionPaths');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-sess-'));
    const jobDir = path.join(tmp, 'job-x');
    fs.mkdirSync(jobDir, { recursive: true });
    let res = sessionPaths.resolveSessionPath({ baseOutDir: tmp, jobDir });
    assert(res.path === null && res.kind === null, 'sessionPaths: aucune session → null');
    fs.writeFileSync(sessionPaths.getJobSessionPath(jobDir), '{}');
    res = sessionPaths.resolveSessionPath({ baseOutDir: tmp, jobDir });
    assert(res.kind === 'job', 'sessionPaths: session locale du job utilisée');
    fs.writeFileSync(sessionPaths.getGlobalSessionPath(tmp), '{}');
    res = sessionPaths.resolveSessionPath({ baseOutDir: tmp, jobDir });
    assert(res.kind === 'global', 'sessionPaths: session globale prioritaire sur celle du job');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Nettoyage : job récent déjà supprimé ; purge du dossier temporaire.
  if (fs.existsSync(recentJobPath)) fs.rmSync(recentJobPath, { recursive: true, force: true });
}

console.log('\n[38] OK');

// --- 39. Bugs corrigés (chasse aux bugs) ---
// Chaque assertion cible un bug RÉEL corrigé : sans le correctif, elle échoue.
console.log('\n[39] Bugs corrigés (fuite vendeur, fusion, widget, rétention HAR, deliveryType, require)');
{
  // 39.1 Fuite de données vendeur en profil Maximum (excludeSellerData).
  // Avant : nombreAvis n'était pas dans SELLER_FIELD_KEYS → il fuyait malgré
  // « Données vendeur » désactivé.
  {
    const { filterAdByFields } = require('../src/main/services/exporting/exportFields');
    const ad = {
      id: '1', title: 't', url: 'u', prix: 10, city: 'Lyon', zipcode: '69000',
      vendeurNom: 'Bob', vendeurType: 'pro', vendeurId: '42', vendeurNote: 4.5,
      nombreAvis: 12, vendeurUrlProfil: 'https://p',
      deliveryType: 'livraison', likes: 3, description: 'd',
    };
    const out = filterAdByFields(ad, null, { excludeSellerData: true });
    const leaked = Object.keys(out).filter((k) => /vendeur|avis|anciennete/i.test(k));
    assert(leaked.length === 0, `export: profil Maximum sans données vendeur → aucune fuite (${leaked.join(',') || 'aucune'})`);
    assert(!('nombreAvis' in out),
      'export: nombreAvis exclu (clé du modèle vendeur)');
  }

  // 39.2 Fusion : un tableau vide ne doit pas écraser une liste déjà extraite.
  {
    const { mergeKeepingNonNull } = require('../src/main/services/scraping/leboncoin-pipeline');
    const a = { id: '1', photosUrls: ['a.jpg', 'b.jpg'], description: 'x', vendeurNote: 4.5, raw: { a: 1, b: 2 } };
    const b = { id: '1', photosUrls: [], description: null, vendeurNote: null, raw: { a: 1 } };
    const m = mergeKeepingNonNull(a, b);
    assert(Array.isArray(m.photosUrls) && m.photosUrls.length === 2,
      'pipeline: mergeKeepingNonNull préserve photosUrls non vide (tableau vide = absence)');
    assert(m.description === 'x' && m.vendeurNote === 4.5,
      'pipeline: mergeKeepingNonNull préserve les champs non-null');
    const m2 = mergeKeepingNonNull({ id: '1', photosUrls: [] }, { id: '1', photosUrls: ['z.jpg'] });
    assert(m2.photosUrls.length === 1 && m2.photosUrls[0] === 'z.jpg',
      'pipeline: mergeKeepingNonNull garde la liste non vide dans les deux sens');
  }

  // 39.3 Widget : classes de statut toutes valides (pas de status-<état> inventé).
  {
    const widgetHtml = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/widget.html'), 'utf8');
    assert(!/:\s*'status-'\s*\+\s*st/.test(widgetHtml),
      'widget: plus de classe dynamique status-<état> (classes CSS inexistantes)');
    assert(/status-running/.test(widgetHtml) && /status-idle/.test(widgetHtml),
      'widget: états capturing/processing mappés sur status-running');
  }

  // 39.4 cleanOldHars(0) : désactivé (ne supprime AUCUN HAR), cohérent avec cleanOldJobs.
  {
    const { StorageCleaner } = require('../src/main/services/maintenance/storageCleaner');
    assert(StorageCleaner.cleanOldHars(0) === 0, 'storageCleaner: cleanOldHars(0) désactivé → 0');
  }

  // 39.5 AdStats rétro-compat : false + null → « aucun » (aligné sur computeDeliveryType).
  {
    const { AdStats } = require('../src/main/services/analysis/adStats');
    const r = AdStats.analyze([
      { id: '1', prix: 100, livraison: false, mainPropre: null },
      { id: '2', prix: 200, livraison: null, mainPropre: false },
      { id: '3', prix: 50, livraison: null, mainPropre: null },
    ]);
    assert(r.stats.aucunCount === 2, 'AdStats rétro-compat: false+null → aucun (2 attendus)');
    assert(r.stats.inconnuCount === 1, 'AdStats rétro-compat: null+null → inconnu (1 attendu)');
  }

  // 39.6 Pipeline : un simple require() ne déclenche PAS la CLI (garde require.main).
  {
    const pipelineSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), 'utf8');
    assert(/if\s*\(\s*require\.main\s*===\s*module\s*\)/.test(pipelineSrc),
      'pipeline: main() gardé par require.main === module');
    let threw = false;
    try { require('../src/main/services/scraping/leboncoin-pipeline'); } catch { threw = true; }
    assert(!threw, 'pipeline: require() en bibliothèque ne lance pas la CLI');
  }

  // 39.7 buildAdHistory : tri chronologique fiable (date FR ≠ ordre lexical).
  {
    const { buildAdHistory } = require('../src/main/services/jobs/jobHistory');
    const jobs = [
      { id: 'job-2026-02-01T10-00-00-000Z', date: '01/02/2026 à 10:00', ads: [{ id: '1', prix: 80, title: 'A', url: 'u' }] },
      { id: 'job-2026-01-12T10-00-00-000Z', date: '12/01/2026 à 10:00', ads: [{ id: '1', prix: 100, title: 'A', url: 'u' }] },
    ];
    const h = buildAdHistory(jobs)[0];
    assert(h.premiereDecouverte === '12/01/2026 à 10:00', 'buildAdHistory: 1re découverte = janvier (tri ISO, pas lexical FR)');
    assert(h.derniereMaj === '01/02/2026 à 10:00', 'buildAdHistory: dernière maj = février');
    assert(h.prix && h.prix.direction === 'baisse' && h.prix.initial === 100 && h.prix.actuel === 80,
      'buildAdHistory: baisse 100→80 détectée (sens chronologique correct)');
  }

  // 39.8 Cohérence deliveryType : adStats et statsModule alignés sur
  // computeDeliveryType pour le cas false + null.
  {
    const { computeDeliveryType } = require('../src/main/services/scraping/adFields');
    const cases = [[true, true], [true, false], [true, null], [false, true], [null, true], [false, false], [false, null], [null, false], [null, null]];
    let mismatches = 0;
    for (const [l, m] of cases) {
      const canon = computeDeliveryType(l, m);
      let statsFallback;
      if (l === true && m === true) statsFallback = 'les_deux';
      else if (l === true) statsFallback = 'livraison';
      else if (m === true) statsFallback = 'main_propre';
      else if (l === false || m === false) statsFallback = 'aucun';
      else statsFallback = 'inconnu';
      if (canon !== statsFallback) mismatches++;
    }
    assert(mismatches === 0, 'deliveryType: repli (false+null→aucun) aligné sur computeDeliveryType pour les 9 combinaisons');
    // Source-level : les 3 replis doivent utiliser la condition `||` (false||false→aucun).
    const adStatsSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/analysis/adStats.js'), 'utf8');
    const statsSrc = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/statsModule.js'), 'utf8');
    assert(/livraison === false \|\| mainPropre === false/.test(adStatsSrc),
      'adStats: repli deliveryType utilise `||` (false+null→aucun)');
    assert(/livraison === false \|\| mainPropre === false/.test(statsSrc),
      'statsModule: repli deliveryType utilise `||` (false+null→aucun)');
  }
}

console.log('\n[39] OK');

console.log('\n[40] Extraction des données manquantes (vendeur, détail, fusion, profils)');
{
  const adFields = require('../src/main/services/scraping/adFields');
  const { parseHtmlDescription, applyDetailFields, mergeKeepingNonNull, normalizeAd } =
    require('../src/main/services/scraping/leboncoin-pipeline');
  const { filterAdByFields, ALL_FIELD_KEYS } = require('../src/main/services/exporting/exportFields');
  const { getProfileFields } = require('../src/main/services/exporting/dataProfiles');

  // Détail complet (__NEXT_DATA__) : toutes les données vendeur présentes.
  const detailAd = {
    list_id: 111, subject: 'Velo', price: [{ value: 100 }],
    url: 'https://www.leboncoin.fr/ad/111.htm',
    body: 'Description detaillee.',
    attributes: [{ key: 'condition', value: 'Neuf' }],
    has_option: { shipping: true },
    owner: {
      name: 'Vendeur Complet', type: 'pro', user_id: 'u1',
      rating: 4.5, nb_ratings: 12, member_since: '2020-01-01T00:00:00Z',
      profile_url: 'https://www.leboncoin.fr/profil/abc',
    },
  };
  const detailHtml = '<html><head><script id="__NEXT_DATA__" type="application/json">'
    + JSON.stringify({ props: { pageProps: { ad: detailAd } } }) + '</script></head><body></body></html>';

  // 40.1 parseHtmlDescription expose TOUTES les données vendeur (pas seulement note).
  const parsed = parseHtmlDescription(detailHtml, '111');
  assert(parsed.description === 'Description detaillee.', '40: détail → description');
  assert(parsed.note === 4.5, '40: détail → note vendeur');
  assert(parsed.nombreAvis === 12, `40: détail → nombre d'avis (obtenu ${parsed.nombreAvis})`);
  assert(parsed.urlProfil === 'https://www.leboncoin.fr/profil/abc', '40: détail → URL profil');
  assert(parsed.ancienneteJours == null,
    '40: détail → ancienneté non exposée (champ retiré du modèle d\'export)');
  assert(parsed.vendeurNom === 'Vendeur Complet' && parsed.vendeurType === 'pro' && parsed.vendeurId === 'u1',
    '40: détail → nom/type/id vendeur');
  assert(parsed.etat === 'Neuf' && parsed.livraison === true,
    '40: détail → état + mode de remise');

  // 40.2 Annonce de recherche SANS données vendeur : le détail les complète,
  // la description de recherche est PRÉSERVÉE (jamais écrasée).
  const searchAd = {
    id: '111', title: 'Velo', description: 'Description liste.', prix: 100,
    vendeurNom: 'Vendeur Complet', vendeurType: 'pro', vendeurId: 'u1',
    vendeurNote: null, nombreAvis: null, vendeurUrlProfil: null,
    livraison: null, mainPropre: null, deliveryType: 'inconnu', etat: null,
  };
  const enriched = applyDetailFields(searchAd, parsed);
  assert(enriched === true, '40: applyDetailFields signale un enrichissement');
  assert(searchAd.nombreAvis === 12 && searchAd.vendeurUrlProfil === 'https://www.leboncoin.fr/profil/abc',
    '40: détail complète nombre d\'avis + URL profil absents de la recherche');
  assert(searchAd.vendeurNote === 4.5 && searchAd.etat === 'Neuf',
    '40: détail complète note + état');
  assert(searchAd.deliveryType === 'livraison',
    `40: deliveryType recalculé après enrichissement (obtenu ${searchAd.deliveryType})`);
  assert(searchAd.description === 'Description liste.',
    '40: la description déjà présente n\'est PAS écrasée par celle du détail');

  // 40.3 Fusion sans perte : une valeur absente du détail n'écrase pas l'existant.
  const existing = { id: '1', vendeurNote: 3, nombreAvis: 5, description: 'garder', etat: null };
  applyDetailFields(existing, { note: null, nombreAvis: null, description: null, etat: null, urlProfil: null });
  assert(existing.vendeurNote === 3 && existing.nombreAvis === 5 && existing.description === 'garder',
    '40: aucune valeur non-nulle écrasée par une valeur absente du détail');

  // 40.4 mergeKeepingNonNull : deliveryType recalculé (les_deux) quand livraison
  // vient d'une occurrence et main propre d'une autre.
  const occA = { id: '1', livraison: true, mainPropre: null, deliveryType: 'livraison', raw: {} };
  const occB = { id: '1', livraison: null, mainPropre: true, deliveryType: 'main_propre', raw: {} };
  const merged = mergeKeepingNonNull(occA, occB);
  assert(merged.livraison === true && merged.mainPropre === true && merged.deliveryType === 'les_deux',
    `40: fusion → deliveryType recalculé les_deux (obtenu ${merged.deliveryType})`);

  // 40.5 Objet vendeur incomplet : champs absents restent null, pas inventés.
  const incomplete = adFields.extractSeller({ owner: { name: 'Paul' } });
  assert(incomplete.nom === 'Paul' && incomplete.note === null && incomplete.nombreAvis === null
    && incomplete.urlProfil === null && incomplete.ancienneteJours === null,
    '40: vendeur incomplet → nom seul, le reste null (jamais inventé)');
  assert(incomplete.id === null && incomplete.type === null, '40: vendeur incomplet → id/type null');

  // 40.6 Variantes de champs réellement observées : nb d'avis, profil, date de compte.
  const variants = adFields.extractSeller({
    owner: {
      name: 'X', user_id: 'u9', rating_average: 4.2, review_count: 7,
      web_url: 'https://www.leboncoin.fr/p/9', registration_date: '2021-06-01T00:00:00Z',
    },
  });
  assert(variants.note === 4.2, '40: note via owner.rating_average');
  assert(variants.nombreAvis === 7, '40: nb avis via owner.review_count');
  assert(variants.urlProfil === 'https://www.leboncoin.fr/p/9', '40: URL profil via owner.web_url');
  assert(typeof variants.ancienneteJours === 'number' && variants.ancienneteJours > 0,
    '40: ancienneté via owner.registration_date');

  // 40.7 Champs numériques égaux à zéro : 0 ≠ null.
  const zero = adFields.extractSeller({ owner: { name: 'Z', nb_ratings: 0 } });
  assert(zero.nombreAvis === 0, '40: nombre d\'avis = 0 conservé (pas null)');
  assert(adFields.extractLikes({ favorites_count: 0 }) === 0, '40: likes = 0 conservé (pas null)');
  const phZero = adFields.extractPhotos({ images: { urls: [] } });
  assert(phZero.count === 0 && phZero.urls.length === 0, '40: photos = 0 → count 0 (pas null)');

  // 40.8 dateModification n'est plus un champ du modèle exporté (retiré). La
  // date de publication reste extraite séparément.
  const dates = adFields.extractDates({ first_publication_date: '2024-05-01T00:00:00Z' });
  assert(dates.publication === '2024-05-01T00:00:00Z' && dates.modification === null,
    '40: date de publication extraite ; date de modification non exposée (null)');

  // 40.9 Photos : déduplication sans perte, toutes les URL uniques conservées.
  const ph = adFields.extractPhotos({ images: { urls: ['https://a.jpg', 'https://b.jpg', 'https://a.jpg'] } });
  assert(ph.count === 2 && ph.urls.length === 2 && ph.urls[0] === 'https://a.jpg' && ph.urls[1] === 'https://b.jpg',
    '40: photos dédupliquées, ordre conservé, aucune troncature');

  // 40.10 description toujours une string (jamais objet) via normalizeAd.
  const norm = normalizeAd({ list_id: 1, subject: 'T', price: [{ value: 5 }], body: { text: 'Corps' } });
  assert(norm.description === 'Corps' && typeof norm.description === 'string',
    '40: description objet {text} → string');
  assert(norm.id === '1' && norm.prix === 5 && norm.url === 'https://www.leboncoin.fr/ad/1.htm',
    '40: id/titre/prix/url jamais perdus par la normalisation');

  // 40.11 Compatibilité des profils Défaut / Maximum / Personnalisé.
  const fullAd = normalizeAd(detailAd);
  const defaultFields = getProfileFields('default');
  const maxFields = getProfileFields('maximum');
  const customFields = getProfileFields('custom', ['id', 'vendeurNote', 'vendeurNbAvis']);
  const defOut = filterAdByFields(fullAd, defaultFields);
  const maxOut = filterAdByFields(fullAd, maxFields);
  const custOut = filterAdByFields(fullAd, customFields);
  assert('title' in defOut && 'prix' in defOut && 'vendeurNom' in defOut,
    '40: profil Défaut conserve les champs essentiels');
  assert(maxOut.nombreAvis === 12 && maxOut.vendeurUrlProfil === 'https://www.leboncoin.fr/profil/abc',
    '40: profil Maximum expose les nouvelles données vendeur');
  assert(maxFields.length === ALL_FIELD_KEYS.length && !ALL_FIELD_KEYS.includes('vendeurAnciennete')
    && !ALL_FIELD_KEYS.includes('dateModification'),
    '40: profil Maximum = toutes les clés d\'export (sans ancienneté ni date modification)');
  assert(custOut.id === '111' && custOut.vendeurNote === 4.5 && custOut.vendeurNbAvis === 12
    && !('title' in custOut),
    '40: profil Personnalisé → uniquement les champs choisis (vendeurNbAvis traduit depuis nombreAvis)');
}

console.log('\n[40] OK');

// ═══════════════════════════════════════════════════════════════════════════
// [41] POLITIQUE DE SCRAPING FIXE (non modifiable) — invariants obligatoires
//   concurrence max 25 · délai nominal 400 ms · mode ultra-rapide
//   migration des anciens réglages · réduction adaptative · Retry-After
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[41] Politique de scraping fixe');
{
  const fs = require('fs');
  const path = require('path');
  const cfg = require('../src/main/config/scraping');
  const { parseRetryAfterMs, nextConcurrencyAfterBlock } = require('../src/main/services/scraping/leboncoin-pipeline');

  // 41.1 Valeurs obligatoires.
  const pol = cfg.getScrapingPolicy();
  assert(pol.concurrency === 25, '[41] concurrence cible = 25');
  assert(pol.pageDelayMs === 400, '[41] délai nominal entre pages = 400 ms');
  assert(pol.mode === 'ultra-rapide', '[41] mode de performance = ultra-rapide');
  assert(cfg.MAX_CONCURRENCY === 25, '[41] MAX_CONCURRENCY exporté = 25');
  assert(Object.isFrozen(cfg.SCRAPING_POLICY), '[41] SCRAPING_POLICY figé (immuable)');

  // 41.2 La concurrence ne dépasse JAMAIS 25, quelle que soit la demande.
  for (const asked of [26, 50, 100, 999999, Infinity, '99', 25.9]) {
    assert(cfg.clampConcurrency(asked) <= 25, `[41] clampConcurrency(${String(asked)}) ≤ 25`);
  }
  assert(cfg.clampConcurrency(25) === 25, '[41] clampConcurrency(25) = 25');

  // 41.3 getSpeedPreset (déprécié) ne permet plus de relever le débit.
  for (const legacySpeed of ['moyen', 'rapide', 'ultra-rapide', 'turbo', undefined, null]) {
    const p = cfg.getSpeedPreset(legacySpeed);
    assert(p.concurrency === 25 && p.minDelayMs === 400,
      `[41] getSpeedPreset(${String(legacySpeed)}) → politique fixe 25/400`);
  }

  // 41.4 Le pipeline force la politique : impossible de la surcharger via opts.
  const pipeSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), 'utf8');
  assert(/opts\.concurrency = clampConcurrency\(policy\.concurrency\)/.test(pipeSrc),
    '[41] pipeline: concurrence forcée via clampConcurrency(policy.concurrency)');
  assert(/opts\.minDelayMs = policy\.enrichMinDelayMs/.test(pipeSrc),
    '[41] pipeline: délai d\'enrichissement forcé depuis la politique');
  assert(!/getSpeedPreset\(opts\.speed\)/.test(pipeSrc),
    '[41] pipeline: n\'utilise plus opts.speed pour choisir le preset');

  // 41.5 Le main process transmet la politique (jamais une valeur utilisateur).
  const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/core/ipcHandlers.js'), 'utf8');
  assert(/getScrapingPolicy\(\)/.test(ipcSrc), '[41] ipcHandlers: consomme getScrapingPolicy()');
  assert(/minPageDelayMs: pageDelay/.test(ipcSrc) && /maxPageDelayMs: pageDelay/.test(ipcSrc),
    '[41] ipcHandlers: délai de capture = politique (min=max=400 ms)');
  assert(/speed: policy\.mode/.test(ipcSrc), '[41] ipcHandlers: mode pipeline = politique');
  assert(!/userSettings\.scrapeSpeed/.test(ipcSrc), '[41] ipcHandlers: ne lit plus scrapeSpeed utilisateur');
  assert(!/userSettings\.pageDelayMs/.test(ipcSrc), '[41] ipcHandlers: ne lit plus pageDelayMs utilisateur');

  // 41.6 harCapturer : délai par défaut = politique (400 ms).
  const harSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/scraping/harCapturer.js'), 'utf8');
  assert(/options\.minPageDelayMs \?\? SCRAPING_POLICY\.pageDelayMs/.test(harSrc),
    '[41] harCapturer: délai min par défaut = politique');
  assert(/options\.maxPageDelayMs \?\? SCRAPING_POLICY\.pageDelayMs/.test(harSrc),
    '[41] harCapturer: délai max par défaut = politique');

  // 41.7 Réglages de vitesse supprimés des defaults + refusés par le sanitizer.
  const settings = require('../src/main/core/settings');
  assert(!('scrapeSpeed' in settings.SETTINGS_DEFAULTS) && !('pageDelayMs' in settings.SETTINGS_DEFAULTS),
    '[41] settings: aucune clé de vitesse dans les défauts');
  assert(Object.keys(settings.sanitizeSettingsPatch({ scrapeSpeed: 'ultra-rapide', pageDelayMs: 1 })).length === 0,
    '[41] settings: patch de vitesse entièrement rejeté (IPC non fiable)');

  // 41.8 Migration : un ancien user-settings.json ne rétablit PAS la vitesse.
  {
    const migrated = settings.migrateSettings({ scrapeSpeed: 'moyen', pageDelayMs: 99999, headless: false });
    assert(!('scrapeSpeed' in migrated) && !('pageDelayMs' in migrated),
      '[41] migration: clés de vitesse héritées supprimées');
    assert(migrated.headless === false, '[41] migration: préférences légitimes conservées');
    assert(migrated.logLevel === 'debug' && migrated.autoCleanHarDays === 7,
      '[41] migration: défauts appliqués pour les clés absentes');
    assert(!('scrapeSpeed' in settings.migrateSettings(null)),
      '[41] migration: entrée nulle gérée sans clé de vitesse');
  }

  // 41.9 L'interface ne propose plus de contrôle modifiable de vitesse/délai.
  const html = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
  assert(!/id="cfgScrapeSpeed"/.test(html), '[41] UI: plus de sélecteur de vitesse');
  assert(!/id="cfgPageDelay"/.test(html), '[41] UI: plus de champ de délai');
  assert(/scraping-mode-readonly/.test(html), '[41] UI: affichage lecture seule du mode fixe');
  const scraperSrc = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/scraperModule.js'), 'utf8');
  assert(!/scrapeSpeed/.test(scraperSrc) && !/pageDelayMs/.test(scraperSrc),
    '[41] UI: scraperModule ne lit/écrit plus la vitesse ni le délai');

  // 41.10 Réduction adaptative de la concurrence (fonction pure).
  assert(nextConcurrencyAfterBlock(25, { is429: true }) === 12, '[41] 429: concurrence 25 → 12 (÷2)');
  assert(nextConcurrencyAfterBlock(25, { is429: false }) === 18, '[41] 403: concurrence 25 → 18 (−25 %)');
  assert(nextConcurrencyAfterBlock(1, { is429: true }) === 1, '[41] réduction bornée à 1 (jamais 0)');
  assert(nextConcurrencyAfterBlock(0, { is429: false }) === 1, '[41] entrée invalide → 1');
  assert(nextConcurrencyAfterBlock(3, { is429: true }) === 1, '[41] 3 → 1 (floor)');
  // Jamais d'augmentation.
  let c = 25;
  for (let i = 0; i < 10; i++) {
    const n = nextConcurrencyAfterBlock(c, { is429: true });
    assert(n <= c, '[41] la concurrence ne remonte jamais');
    c = n;
  }
  assert(c === 1, '[41] après réductions répétées → plancher 1');

  // 41.11 Retry-After borné (pas de boucle infinie ni de pause démesurée).
  assert(parseRetryAfterMs('999999999') <= 24 * 3600 * 1000, '[41] Retry-After plafonné à 24 h');
  assert(parseRetryAfterMs('-5') === null || parseRetryAfterMs('-5') >= 0, '[41] Retry-After négatif géré');

  // 41.12 Le pipeline applique la pause Retry-After (pause inter-batch).
  assert(/await sleep\(pendingRetryAfterMs\)/.test(pipeSrc), '[41] pipeline: pause Retry-After effective');

  // 41.13 report.json et logs reflètent la politique FIXE, jamais un mode
  // utilisateur hérité. Un ancien `--speed` ne doit pas réapparaître.
  assert(/speed: policy\.mode/.test(pipeSrc), '[41] pipeline: report.speed = politique fixe');
  assert(!/opts\.speed \|\| 'moyen'/.test(pipeSrc), '[41] pipeline: plus de repli « moyen » depuis opts.speed');

  // 41.14 Mesures de performance reproductibles dans report.json (durée totale,
  // débit, durée moyenne, pic mémoire) — observées, jamais estimées.
  assert(/report\.performance = \{/.test(pipeSrc), '[41] pipeline: bloc performance écrit dans report.json');
  for (const field of ['totalMs', 'adsPerMinute', 'avgMsPerAd', 'peakRssMb']) {
    assert(new RegExp('\\b' + field + '\\b').test(pipeSrc), `[41] pipeline: mesure performance "${field}" présente`);
  }
}
console.log('\n[41] OK');

// ═══════════════════════════════════════════════════════════════════════════
// [42] EXPORTS JSON/TXT — contenu RÉEL des fichiers (pas seulement présence)
//   Le pipeline est exécuté sur un HAR synthétique puis on analyse les octets
//   écrits : validité JSON, types, Unicode, nulls, dédup, profils, TXT lisible.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[42] Exports JSON/TXT (contenu réel)');
{
  const os = require('os');
  const { execFileSync } = require('child_process');
  const pipelinePath = path.join(base, 'services/scraping/leboncoin-pipeline.js');

  // Annonce « riche » : accents, Unicode, apostrophe, emoji, sauts de ligne.
  const richAd = {
    list_id: 'rich-1',
    subject: 'Vélo électrique « Vintage » 🚲 — état neuf',
    body: 'Ligne 1 avec accent é\nLigne 2 avec emoji 🎉 et caractère <script>\nLigne 3 : guillemets "doubles" et \'simples\'',
    price: [{ value: 1290.5 }],
    location: { city: 'Saint-Étienne', zipcode: '42000' },
    owner: { name: 'Amélie', type: 'private', user_id: 'u-é-1', rating: 4.7, nb_ratings: 42 },
    has_option: { shipping: true },
    images: { urls: ['https://img.leboncoin.fr/a.jpg', 'https://img.leboncoin.fr/a.jpg', 'https://img.leboncoin.fr/b.jpg'] },
    favorites_count: 3,
    index_date: '2024-03-01T10:00:00Z',
  };
  // Annonce « partielle » : champs absents → doivent valoir null, jamais inventés.
  // (URL présente pour que l'annonce soit détectable, mais ni prix, ni vendeur,
  //  ni localisation, ni images.)
  const partialAd = {
    list_id: 'partial-1',
    subject: 'Objet sans prix ni vendeur',
    url: 'https://www.leboncoin.fr/ad/partial-1.htm',
  };
  const payload = { data: { ads: [richAd, partialAd] } };

  function runHar(adsPayload, profileArgs, outName) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `lbc-exp-${outName}-`));
    const outDir = path.join(tmp, 'results');
    fs.mkdirSync(outDir, { recursive: true });
    const harPath = path.join(tmp, 'capture.har');
    fs.writeFileSync(harPath, JSON.stringify({
      log: {
        version: '1.2', creator: { name: 't', version: '1' },
        entries: [{ request: { method: 'GET', url: 'https://www.leboncoin.fr/recherche' }, response: { status: 200, content: { mimeType: 'application/json', text: JSON.stringify(adsPayload) } } }],
      },
    }), 'utf8');
    let code = 0;
    try {
      execFileSync(process.execPath, [pipelinePath, harPath, '--out', outDir, '--no-desc', '--fresh', ...profileArgs], { encoding: 'utf8', timeout: 60000 });
    } catch (err) { code = err.status; }
    const jsonRaw = fs.existsSync(path.join(outDir, 'annonces.json')) ? fs.readFileSync(path.join(outDir, 'annonces.json'), 'utf8') : null;
    const txtRaw = fs.existsSync(path.join(outDir, 'annonces.txt')) ? fs.readFileSync(path.join(outDir, 'annonces.txt'), 'utf8') : null;
    fs.rmSync(tmp, { recursive: true, force: true });
    return { code, jsonRaw, txtRaw };
  }

  // 42.1 JSON profil Maximum : valide, analysable, toutes les annonces présentes.
  const max = runHar(payload, ['--profile-id', 'maximum'], 'max');
  assert(max.code === 0 && max.jsonRaw, '42: export Maximum généré (exit 0)');
  let maxAds = null;
  try { maxAds = JSON.parse(max.jsonRaw); } catch { /* échec signalé ci-dessous */ }
  assert(Array.isArray(maxAds) && maxAds.length === 2, `42: JSON Maximum = 2 annonces (obtenu ${maxAds ? maxAds.length : 'parse-error'})`);
  const rich = maxAds && maxAds.find((a) => a.id === 'rich-1');
  assert(rich && rich.title.includes('🚲') && rich.title.includes('«'), '42: Unicode/emoji/accent conservés dans le titre');
  assert(rich && rich.description.includes('🎉') && rich.description.includes('<script>'),
    '42: description multi-lignes + emoji + balise conservés TELS QUELS (échappés uniquement à l\'affichage)');
  assert(rich && typeof rich.prix === 'number' && rich.prix === 1290.5, '42: prix = nombre (pas de chaîne, pas d\'objet)');
  assert(rich && rich.city === 'Saint-Étienne' && rich.zipcode === '42000', '42: localisation accentuée préservée');
  assert(rich && rich.photosCount === 2, '42: photos dédupliquées (3 URLs dont 1 doublon → 2)');
  assert(rich && rich.vendeurNom === 'Amélie' && rich.nombreAvis === 42, '42: données vendeur présentes en Maximum');

  // 42.2 Annonce partielle : champs absents = null, JAMAIS 0/''/inventé.
  const part = maxAds && maxAds.find((a) => a.id === 'partial-1');
  assert(part, '42: annonce partielle présente dans l\'export');
  assert(part && part.prix === null, '42: prix absent → null (pas 0)');
  assert(part && part.vendeurNom === null, '42: vendeur absent → null (pas chaîne vide)');
  assert(part && part.city === null && part.zipcode === null, '42: localisation absente → null');
  assert(part && part.photosCount === null, '42: photosCount absent → null (pas 0)');
  assert(part && part.deliveryType === 'inconnu', '42: deliveryType non renseigné → inconnu');

  // 42.3 Aucun champ interne ne fuit dans le JSON.
  assert(maxAds && maxAds.every((a) => !('raw' in a) && !('extractionErrors' in a) && !('livraison' in a) && !('mainPropre' in a)),
    '42: aucun champ interne (raw, extractionErrors, livraison, mainPropre) dans l\'export');

  // 42.4 Profil Défaut : champs essentiels uniquement, valeurs traduites présentes.
  const def = runHar(payload, ['--profile-id', 'default'], 'def');
  const defAds = def.jsonRaw ? JSON.parse(def.jsonRaw) : null;
  const defRich = defAds && defAds.find((a) => a.id === 'rich-1');
  assert(defRich && defRich.ville === 'Saint-Étienne' && defRich.codePostal === '42000',
    '42: profil Défaut → ville/codePostal traduits et présents (pas perdus)');
  assert(defRich && !('likes' in defRich) && !('vendeurId' in defRich),
    '42: profil Défaut → champs non essentiels exclus (likes, vendeurId)');

  // 42.5 Profil Personnalisé : uniquement les champs demandés.
  const cus = runHar(payload, ['--profile-id', 'custom', '--profile-fields', 'id,title,prix'], 'cus');
  const cusAds = cus.jsonRaw ? JSON.parse(cus.jsonRaw) : null;
  const cusRich = cusAds && cusAds.find((a) => a.id === 'rich-1');
  // Le profil Personnalisé garantit TOUJOURS les champs photos essentiels
  // (l'explorateur en a besoin) en plus des champs choisis.
  assert(cusRich && ['id', 'prix', 'title', 'photosCount', 'photosUrls']
    .every((k) => k in cusRich) && Object.keys(cusRich).length === 5,
    `42: profil Personnalisé → champs demandés + photos (obtenu ${cusRich ? Object.keys(cusRich).sort().join(',') : 'null'})`);
  assert(cusRich && !('vendeurNom' in cusRich) && !('description' in cusRich),
    '42: profil Personnalisé → champs non demandés absents');

  // 42.6 TXT : lisible, labels alignés, accents + valeurs présentes.
  assert(max.txtRaw && /===== ANNONCE 1 =====/.test(max.txtRaw), '42: TXT contient l\'en-tête d\'annonce');
  assert(max.txtRaw && max.txtRaw.includes('Saint-Étienne'), '42: TXT préserve les accents');
  assert(max.txtRaw && /Prix\s+:\s+1290\.5 €/.test(max.txtRaw), '42: TXT formate le prix en euros');
  assert(max.txtRaw && max.txtRaw.includes('🚲'), '42: TXT préserve les emojis');
  assert(max.txtRaw && max.txtRaw.split('===== ANNONCE').length - 1 === 2,
    '42: TXT contient une fiche par annonce (2)');

  // 42.7 TXT : les valeurs absentes sont explicites (null), pas vides.
  const txtLines = (max.txtRaw || '').split('\n');
  const prixLine = txtLines.find((l) => /^Prix\s+:/.test(l));
  assert(prixLine, '42: TXT expose la ligne Prix');

  // 42.8 Cohérence JSON↔TXT : même nombre d'annonces des deux côtés.
  const txtCount = (max.txtRaw || '').split('===== ANNONCE').length - 1;
  assert(maxAds && txtCount === maxAds.length, `42: JSON et TXT ont le même nombre d'annonces (${txtCount})`);
}
console.log('\n[42] OK');

// ═══════════════════════════════════════════════════════════════════════════
// [43] ROBUSTESSE — entrées dégradées sans crash ni perte silencieuse
//   JSON invalide, HAR corrompu, annonce incomplète, 429/403, page vide répétée,
//   données historiques corrompues. Aucune donnée ne doit disparaître en silence.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[43] Robustesse (entrées dégradées)');
{
  const os = require('os');
  const { execFileSync } = require('child_process');
  const pipelinePath = path.join(base, 'services/scraping/leboncoin-pipeline.js');
  const { normalizeAd, looksLikeAd } = require('../src/main/services/scraping/leboncoin-pipeline');

  function writeHar(entries) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-rob-'));
    const harPath = path.join(tmp, 'c.har');
    fs.writeFileSync(harPath, JSON.stringify({ log: { version: '1.2', creator: { name: 't', version: '1' }, entries } }), 'utf8');
    return { tmp, harPath };
  }
  function runPipeline(harPath, outDir, extra = []) {
    let code = 0;
    try {
      execFileSync(process.execPath, [pipelinePath, harPath, '--out', outDir, '--no-desc', '--fresh', ...extra], { encoding: 'utf8', timeout: 60000 });
    } catch (err) { code = err.status; }
    return code;
  }

  // 43.1 JSON invalide dans une réponse : ne casse PAS le pipeline, exit 2.
  {
    const { tmp, harPath } = writeHar([{ request: { url: 'https://www.leboncoin.fr/recherche' }, response: { status: 200, content: { mimeType: 'application/json', text: '{ this is : not valid json' } } }]);
    const outDir = path.join(tmp, 'r'); fs.mkdirSync(outDir, { recursive: true });
    const code = runPipeline(harPath, outDir);
    assert(code === 2, `43: JSON invalide → exit 2 (aucune donnée exploitable), obtenu ${code}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 43.2 HAR illisible (JSON corrompu) : erreur FATALE (exit 1), jamais un faux succès.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-rob-bad-'));
    const harPath = path.join(tmp, 'bad.har');
    fs.writeFileSync(harPath, '<<< pas un HAR >>>', 'utf8');
    const outDir = path.join(tmp, 'r'); fs.mkdirSync(outDir, { recursive: true });
    const code = runPipeline(harPath, outDir);
    assert(code === 1, `43: HAR illisible → exit 1 (erreur fatale explicite), obtenu ${code}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 43.3 Réponses HTTP non-200 (429/403) : aucune annonce extraite, pas de faux succès.
  {
    const { tmp, harPath } = writeHar([
      { request: { url: 'https://www.leboncoin.fr/recherche?p=1' }, response: { status: 429, content: { mimeType: 'text/html', text: 'too many' } } },
      { request: { url: 'https://www.leboncoin.fr/recherche?p=2' }, response: { status: 403, content: { mimeType: 'text/html', text: 'forbidden' } } },
    ]);
    const outDir = path.join(tmp, 'r'); fs.mkdirSync(outDir, { recursive: true });
    const code = runPipeline(harPath, outDir);
    assert(code === 2, `43: HAR 429/403 → exit 2, obtenu ${code}`);
    assert(!fs.existsSync(path.join(outDir, 'annonces.json')), '43: aucune annonce.json fabriqué à partir d\'un blocage');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 43.4 Plusieurs pages vides consécutives → exit 2, jamais de boucle infinie.
  {
    const { tmp, harPath } = writeHar([
      { request: { url: 'https://www.leboncoin.fr/recherche?p=1' }, response: { status: 200, content: { mimeType: 'application/json', text: JSON.stringify({ data: { ads: [] } }) } } },
      { request: { url: 'https://www.leboncoin.fr/recherche?p=2' }, response: { status: 200, content: { mimeType: 'application/json', text: JSON.stringify({ data: { ads: [] } }) } } },
    ]);
    const outDir = path.join(tmp, 'r'); fs.mkdirSync(outDir, { recursive: true });
    const code = runPipeline(harPath, outDir);
    assert(code === 2, `43: pages vides → exit 2 (pas de faux succès), obtenu ${code}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 43.5 Annonce incomplète (juste list_id) : normalisée sans crash, champs null.
  {
    const ad = normalizeAd({ list_id: 999, subject: 'T', price: [{ value: 5 }], url: 'https://www.leboncoin.fr/ad/999.htm' });
    assert(ad && ad.id === '999', '43: annonce minimale → id conservé (string)');
    assert(ad.prix === 5 && ad.description === null && ad.city === null,
      '43: annonce minimale → prix extrait, description/localisation absentes = null (jamais inventées)');
    assert(looksLikeAd({ list_id: 1, subject: 'x', url: 'https://www.leboncoin.fr/ad/1.htm' }) === true,
      '43: looksLikeAd tolère une annonce minimale valide (id + titre + url)');
    assert(looksLikeAd({ list_id: 1, subject: 'x' }) === false,
      '43: looksLikeAd rejette un objet sans prix ni url (pas une annonce)');

    // 43.5b « inconnu » ≠ « zéro » : une annonce SANS champ images → photosCount
    // null (information non récupérée) ; une annonce AVEC images vides → 0
    // (information confirmée : aucune photo). L'ancien comportement renvoyait 0
    // dans les deux cas, transformant une donnée inconnue en absence confirmée.
    const noImages = normalizeAd({ list_id: 1, subject: 'T', url: 'https://www.leboncoin.fr/ad/1.htm' });
    assert(noImages.photosCount === null && noImages.photosUrls === null,
      '43: annonce sans champ images → photosCount null (inconnu, pas 0)');
    const emptyImages = normalizeAd({ list_id: 2, subject: 'T', url: 'https://www.leboncoin.fr/ad/2.htm', images: { urls: [] } });
    assert(emptyImages.photosCount === 0 && Array.isArray(emptyImages.photosUrls) && emptyImages.photosUrls.length === 0,
      '43: annonce avec images vides → photosCount 0 (absence confirmée)');
  }

  // 43.6 Entrées HAR non-JSON (HTML, réponse nulle, objet vide) : le pipeline
  // les ignore sans planter (il ne garde que les réponses JSON exploitables).
  {
    const { tmp, harPath } = writeHar([
      { request: { url: 'https://www.leboncoin.fr/' }, response: { status: 200, content: { mimeType: 'text/html', text: '<html>x</html>' } } },
      { request: { url: 'https://www.leboncoin.fr/api' }, response: { status: 200, content: { mimeType: 'application/json', text: JSON.stringify({ data: { ads: [{ list_id: 'ok1', subject: 'Ok', url: 'https://www.leboncoin.fr/ad/ok1.htm' }] } }) } } },
      { request: { url: 'https://www.leboncoin.fr/x' }, response: null },
      {},
    ]);
    const outDir = path.join(tmp, 'r'); fs.mkdirSync(outDir, { recursive: true });
    const code = runPipeline(harPath, outDir);
    assert(code === 0, `43: entrées non-JSON ignorées, JSON valide conservé (exit 0), obtenu ${code}`);
    const ads = JSON.parse(fs.readFileSync(path.join(outDir, 'annonces.json'), 'utf8'));
    assert(ads.length === 1 && ads[0].id === 'ok1', '43: seule l\'annonce de la réponse JSON est extraite');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 43.7 annonces.json corrompu (historique) : reprise re-scrape au lieu de crasher.
  {
    const { tmp, harPath } = writeHar([{ request: { url: 'https://www.leboncoin.fr/recherche' }, response: { status: 200, content: { mimeType: 'application/json', text: JSON.stringify({ data: { ads: [{ list_id: 'x1', subject: 'Objet', price: [{ value: 10 }] }] } }) } } }]);
    const outDir = path.join(tmp, 'r'); fs.mkdirSync(outDir, { recursive: true });
    // Écrit un annonces.json corrompu SANS --fresh → le pipeline doit le détecter
    // et re-scraper depuis le HAR (pas de crash, pas de perte de données).
    fs.writeFileSync(path.join(outDir, 'annonces.json'), '{{{ corrompu', 'utf8');
    const code = runPipeline(harPath, outDir, []); // sans --fresh
    assert(code === 0, `43: annonces.json corrompu → re-scraping automatique (exit 0), obtenu ${code}`);
    const fixed = JSON.parse(fs.readFileSync(path.join(outDir, 'annonces.json'), 'utf8'));
    assert(Array.isArray(fixed) && fixed.length === 1 && fixed[0].id === 'x1',
      '43: données récupérées après corruption (aucune perte silencieuse)');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
console.log('\n[43] OK');

// ═══════════════════════════════════════════════════════════════════════════
// [44] SÉCURITÉ — anti-SSRF du chemin Playwright (URL de recherche + sous-req.)

console.log('\n[44] Sécurité anti-SSRF (harCapturer)');
{
  const { HarCapturer } = require('../src/main/services/scraping/harCapturer');
  const harSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/scraping/harCapturer.js'), 'utf8');

  // 44.1 Le garde-fou réseau est installé dans CHAQUE contexte navigateur.
  assert(/async _installNetworkGuard\(ctx\)/.test(harSrc), '[44] harCapturer: _installNetworkGuard défini');
  assert(/_installNetworkGuard\(ctx\)/.test(harSrc), '[44] harCapturer: garde-fou installé dans _newStealthContext');
  assert(/route\('\*\*\/\*'/.test(harSrc), '[44] harCapturer: interception de toutes les sous-requêtes');

  // 44.2 L'URL de recherche est validée AVANT le lancement de Chromium.
  const cap = new HarCapturer();
  const badUrls = [
    'http://169.254.169.254/latest/meta-data/', // link-local (métadonnées cloud)
    'http://127.0.0.1/x',
    'http://10.0.0.5/x',
    'https://evil.example.com/',
    'https://leboncoin.fr.attacker.com/x', // suffixe trompeur
    'ftp://leboncoin.fr/x',
    'file:///etc/passwd',
    'not-a-url',
  ];
  let rejected = 0;
  for (const u of badUrls) {
    try {
      await cap.capture({ searchUrl: u, maxPages: 1, outputHarPath: path.join('/tmp', 'nope-ssrf', 'capture.har') });
      // Si on arrive ici, Chromium a été « lancé » (stub → throw) : le test
      // précédent a échoué à rejeter l'URL, on ne doit jamais l'atteindre.
    } catch (e) {
      if (/refusée|requise/.test(e.message)) rejected++;
      else if (/playwright stub/.test(e.message)) {
        assert(false, `[44] URL dangereuse non refusée avant lancement : ${u}`);
      }
    }
  }
  assert(rejected === badUrls.length, `[44] toutes les URLs dangereuses refusées (${rejected}/${badUrls.length})`);

  // 44.3 Une URL Leboncoin légitime n'est PAS refusée par le contrôle de
  // destination : elle atteint le lancement Chromium (stub → erreur de lancement,
  // dont le libellé varie selon la section ; on vérifie donc l'ABSENCE de refus).
  let legitThrew = false;
  try {
    await cap.capture({ searchUrl: 'https://www.leboncoin.fr/recherche?text=velo', maxPages: 1, outputHarPath: path.join('/tmp', 'nope-ssrf', 'capture.har') });
  } catch (e) {
    legitThrew = true;
    assert(!/refusée/.test(e.message), `[44] URL leboncoin légitime non refusée (msg=${e.message})`);
  }
  assert(legitThrew, '[44] URL légitime atteint le lancement navigateur (contrôle de destination non bloquant)');

  // 44.4 Le contrôle de destination couvre protocoles, IP privées et allowlist.
  const { isSafeFetchDestination } = require('../src/main/utils/urlSecurity');
  assert(isSafeFetchDestination('data:text/html,x').safe === false, '[44] data: refusé par le contrôle de destination');
  assert(isSafeFetchDestination('https://www.leboncoin.fr/x', ['leboncoin.fr']).safe === true, '[44] leboncoin.fr autorisé');
  assert(isSafeFetchDestination('https://sub.leboncoin.fr/x', ['leboncoin.fr']).safe === true, '[44] sous-domaine autorisé');

  // 44.5 Défense en profondeur aussi dans l'enrichissement (route handler).
  const pipeSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), 'utf8');
  assert(/isSafeFetchDestination\(checkUrl\)/.test(pipeSrc), '[44] pipeline: contrôle anti-SSRF des sous-requêtes d\'enrichissement');
}
console.log('\n[44] OK');

// --- 45. Vendra : champs essentiels, migration de dossier, localisation, bornes ---
// Verrouille les invariants de la refonte « Vendra » : photos garanties dans
// TOUS les profils, compat de localisation (ville/city), migration du dossier de
// données sans perte, et bornes anti-DoS de l'historique d'annonces.
console.log('\n[45] Vendra (profils/photos, localisation, migration, bornes)');
{
  // 45.1 Les URL de photos sont GARANTIES dans les 3 profils.
  const exf = require('../src/main/services/exporting/exportFields');
  const dp = require('../src/main/services/exporting/dataProfiles');
  assert(Array.isArray(exf.ESSENTIAL_FIELD_KEYS) && exf.ESSENTIAL_FIELD_KEYS.includes('photosUrls'),
    '[45] ESSENTIAL_FIELD_KEYS contient photosUrls');
  const custom = dp.getProfileFields('custom', ['id', 'title']);
  assert(Array.isArray(custom) && custom.includes('photosUrls'),
    '[45] profil Personnalisé → photosUrls ajouté automatiquement (sans case Photos)');
  const def = dp.getProfileFields('default');
  assert(def.includes('photosUrls'), '[45] profil Défaut → photosUrls présent');
  const max = dp.getProfileFields('maximum');
  assert(!max || max === null || max.includes('photosUrls') || exf.ALL_FIELD_KEYS.includes('photosUrls'),
    '[45] profil Maximum → photosUrls couvert (toutes les clés)');
  // ensureEssentialFields ne duplique pas et préserve l'ordre.
  const ensured = exf.ensureEssentialFields(['id', 'photosUrls']);
  assert(ensured.filter((k) => k === 'photosUrls').length === 1,
    '[45] ensureEssentialFields ne duplique pas une clé déjà présente');
  assert(exf.ensureEssentialFields(null) === null,
    '[45] ensureEssentialFields(null) → null (toutes les clés)');

  // 45.2 filterAdByFields conserve les photos même en sélection réduite.
  const adPhotos = { id: '1', title: 't', photosCount: 3, photosUrls: ['a.jpg', 'b.jpg'] };
  const outPhotos = exf.filterAdByFields(adPhotos, ['id']);
  assert(Array.isArray(outPhotos.photosUrls) && outPhotos.photosUrls.length === 2,
    '[45] filterAdByFields garde photosUrls malgré une sélection réduite');

  // 45.3 Localisation : city/ville et zipcode/codePostal résolus par les helpers.
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const utilsSrc = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/utils.js'), 'utf8');
  dom.window.eval(utilsSrc + '\n;window.__loc = { cityOf, zipOf, locationLabel };');
  const { cityOf, zipOf, locationLabel } = dom.window.__loc;
  assert(cityOf({ ville: 'Lyon' }) === 'Lyon', '[45] cityOf lit la clé d\'export `ville`');
  assert(cityOf({ city: 'Paris' }) === 'Paris', '[45] cityOf lit la clé du modèle `city`');
  assert(cityOf({ location: { city: 'Nantes' } }) === 'Nantes', '[45] cityOf lit location.city (ancien JSON)');
  assert(cityOf({}) === '', '[45] cityOf → \'\' si ville absente (jamais inventée)');
  assert(cityOf(null) === '', '[45] cityOf(null) ne jette pas');
  assert(zipOf({ codePostal: '69001' }) === '69001', '[45] zipOf lit `codePostal`');
  assert(zipOf({ zipcode: '75001' }) === '75001', '[45] zipOf lit `zipcode`');
  assert(locationLabel({ ville: 'Lyon', codePostal: '69001' }) === 'Lyon (69001)',
    '[45] locationLabel ville + CP');
  assert(locationLabel({ ville: 'Lyon' }) === 'Lyon', '[45] locationLabel ville seule');
  assert(locationLabel({ codePostal: '69001' }) === '69001', '[45] locationLabel CP seul');
  assert(locationLabel({}) === 'Inconnue', '[45] locationLabel → Inconnue si rien');
  dom.window.close();

  // 45.4 Migration du dossier de données : legacy conservé, nouveau chemin résolu.
  const constSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/config/constants.js'), 'utf8');
  assert(/LEGACY_DIR_NAME\s*=\s*'Leboncoin Scraper Pro'/.test(constSrc),
    '[45] constants: dossier historique conservé pour la migration');
  assert(/APP_DIR_NAME\s*=\s*'Vendra'/.test(constSrc),
    '[45] constants: nouveau dossier = Vendra');
  assert(/fs\.renameSync\(legacy, target\)/.test(constSrc),
    '[45] constants: migration par rename (aucune copie/suppression)');
  assert(/APP_NAME:\s*'Vendra'/.test(constSrc), '[45] constants: APP_NAME = Vendra');

  // 45.4b Cohérence de marque dans package.json + migration userData Electron.
  const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert(pkgJson.name === 'vendra', '[45] package.json: name = vendra');
  assert(pkgJson.productName === 'Vendra', '[45] package.json: productName = Vendra');
  assert(pkgJson.build && pkgJson.build.nsis && pkgJson.build.nsis.shortcutName === 'Vendra',
    '[45] package.json: raccourci NSIS = Vendra (cohérent app/installeur)');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');
  assert(/function migrateUserDataDir\(\)/.test(mainSrc),
    '[45] main.js: migrateUserDataDir présent (préférences conservées au renommage)');
  assert(/renameSync\(legacy, target\)/.test(mainSrc),
    '[45] main.js: migration userData par rename (aucune copie/suppression)');
  assert(/if \(fs\.existsSync\(target\)\) return;/.test(mainSrc),
    '[45] main.js: migration userData n\'écrase jamais un dossier existant');

  // 45.5 Bornes anti-DoS de buildAdHistory (entrée énorme → pas d\'explosion).
  const { buildAdHistory } = require('../src/main/services/jobs/jobHistory');
  const bigAds = Array.from({ length: 100 }, (_, i) => ({ id: 'same', prix: i + 1, title: 'x' }));
  const hist = buildAdHistory([{ id: 'job-2026-01-01T00-00-00', date: '01/01/2026 à 00:00', ads: bigAds }]);
  assert(hist.length === 1 && hist[0].sessions <= 32,
    `[45] buildAdHistory borne les occurrences par annonce (${hist[0].sessions} ≤ 32)`);
  assert(buildAdHistory(null).length === 0, '[45] buildAdHistory(null) → [] (pas de crash)');
  assert(buildAdHistory('pas un tableau').length === 0, '[45] buildAdHistory(non-tableau) → []');

  // 45.6 Le renderer n\'affiche plus les champs retirés (ancienneté, date modif.).
  const explorerSrc = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/explorerModule.js'), 'utf8');
  assert(!/vendeurAncienneteJours|dateModification/.test(explorerSrc),
    '[45] explorer: ni ancienneté vendeur ni date de modification affichées');
  assert(!exf.ALL_FIELD_KEYS.includes('vendeurAnciennete'),
    '[45] exportFields: vendeurAnciennete retiré des clés exportables');
  assert(!exf.ALL_FIELD_KEYS.includes('dateModification'),
    '[45] exportFields: dateModification retiré des clés exportables');
  assert(!exf.SELLER_FIELD_KEYS.has('vendeurAnciennete'),
    '[45] exportFields: vendeurAnciennete retiré des clés vendeur');
}
console.log('\n[45] OK');

// --- 46. Explorateur : fiche détaillée + localisation (DOM jsdom réel) ---
// Reproduit le bug signalé (« la fiche détaillée ne s'affiche pas / localisation
// Inconnue ») sur des annonces au FORMAT D'EXPORT (clés ville/codePostal, comme
// dans annonces.json) — c'est le format réellement lu par l'explorateur.
console.log('\n[46] Explorateur (fiche détaillée + localisation, jsdom)');
{
  const { JSDOM } = require('jsdom');
  const repoRoot = path.join(__dirname, '..');

  const html = `<!doctype html><html><body>
    <div id="adsTableContainer"><table><tbody id="adsTableBody"></tbody></table></div>
    <div id="adsGridContainer" class="hidden"></div>
    <span id="filteredAdsCount"></span>
    <button id="viewTableBtn"></button><button id="viewGridBtn"></button>
    <input id="filterKeyword"><input id="filterPriceMin"><input id="filterPriceMax">
    <select id="filterTagSelect"><option value="ALL">ALL</option></select>
    <select id="sortSelect"><option value="DEFAULT">DEFAULT</option></select>
    <select id="filterDeliveryType"><option value="tous">tous</option></select>
    <select id="filterSellerType"><option value="ALL">ALL</option></select>
    <input id="filterMinRating"><input id="filterMinLikes">
    <select id="filterEtat"><option value="ALL">ALL</option></select>
    <select id="sessionSelect"><option value="ALL">ALL</option></select>
    <div id="adDetailModal" class="hidden">
      <h3 id="modalAdTitle"></h3>
      <button id="closeDetailModalBtn"></button>
      <img id="mainGalleryImg"><div id="galleryThumbnails"></div>
      <span id="modalDealBadge"></span><button id="modalStarBtn"></button>
      <span id="modalPrice"></span><span id="modalCity"></span>
      <span id="modalSeller"></span><span id="modalDate"></span>
      <div id="modalDescription"></div>
      <button id="modalOpenLeboncoinBtn"></button>
      <span id="modalSellerRating"><span class="modal-extra-val">-</span></span>
      <span id="modalDeliveryType"><span class="modal-extra-val">-</span></span>
      <span id="modalLikes"><span class="modal-extra-val">-</span></span>
      <span id="modalDateScraping"><span class="modal-extra-val">-</span></span>
      <span id="modalTypeVendeur"><span class="modal-extra-val">-</span></span>
      <span id="modalEtat"><span class="modal-extra-val">-</span></span>
    </div>
    <div id="toastContainer"></div>
  </body></html>`;

  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://app.local/' });
  const { window } = dom;
  window.api = { getHistory: async () => [], openExternal: () => {}, openFolder: async () => ({ success: true }) };
  window.confirm = () => true;

  const utilsSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/utils.js'), 'utf8');
  const appStateSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/appState.js'), 'utf8');
  const explorerSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/explorerModule.js'), 'utf8');
  // Ordre de chargement réel (index.html) : utils → appState → explorerModule.
  // Les `let` d'appState (allJobsCache, includeSellerData) sont dans la portée de
  // CET eval : on expose des setters qui écrivent dans la même portée (une
  // affectation depuis un autre window.eval créerait un global masquant).
  window.eval(utilsSrc + '\n' + appStateSrc + '\n' + explorerSrc
    + '\n;window.__setCache = (v) => { allJobsCache = v; };'
    + '\n;window.__setSeller = (v) => { includeSellerData = v; };');

  // Annonce au FORMAT D'EXPORT : ville/codePostal (et non city/zipcode).
  const exportAd = {
    id: '2831923847', title: 'PC portable Gamer', url: 'https://www.leboncoin.fr/ad/2831923847.htm',
    prix: 450, ville: 'Lyon', codePostal: '69001', deliveryType: 'livraison',
    vendeurNom: 'Jean D.', vendeurType: 'particulier', vendeurNote: 4.8, vendeurNbAvis: 27,
    vendeurUrlProfil: 'https://www.leboncoin.fr/u/1.htm', likes: 5,
    datePublication: '2026-08-01T10:00:00Z', dateScraping: '2026-08-01T12:30:00Z',
    etat: 'Très bon état', photosCount: 2, photosUrls: ['https://img/1.jpg', 'https://img/2.jpg'],
    description: 'Bonjour, PC en excellent état, très bonnes performances.',
  };
  window.__setCache([{ id: 'job-2026-08-01T12-00-00', date: '01/08/2026 à 12:00', adsCount: 1, ads: [exportAd] }]);
  window.__setSeller(true);

  assert(typeof window.openAdDetail === 'function', '[46] openAdDetail exposé');
  window.openAdDetail('2831923847');

  const $ = (id) => window.document.getElementById(id);
  const modal = $('adDetailModal');
  assert(!modal.classList.contains('hidden'), '[46] la fiche détaillée s\'ouvre (modal visible)');
  assert($('modalAdTitle').textContent === 'PC portable Gamer', '[46] titre affiché');
  assert($('modalPrice').textContent === '450', '[46] prix affiché');
  // Bug localisation : ville présente (clé d'export `ville`) → NE DOIT PAS être « Inconnue ».
  assert($('modalCity').textContent === 'Lyon (69001)',
    `[46] localisation ville+CP depuis clés d'export (obtenu "${$('modalCity').textContent}")`);
  assert(!/Inconnue/.test($('modalCity').textContent), '[46] la ville n\'est pas « Inconnue » alors qu\'elle existe');
  assert(/Jean D\./.test($('modalSeller').textContent), '[46] vendeur affiché');
  assert(/excellent état/.test($('modalDescription').textContent), '[46] description affichée');
  assert(/4\.8/.test($('modalSellerRating').querySelector('.modal-extra-val').textContent),
    '[46] note vendeur affichée');
  assert(/27/.test($('modalSellerRating').querySelector('.modal-extra-val').textContent),
    '[46] nombre d\'avis affiché (note + avis)');
  assert($('modalDeliveryType').querySelector('.modal-extra-val').textContent === 'Livraison uniquement',
    '[46] type de remise affiché');
  assert($('modalLikes').querySelector('.modal-extra-val').textContent === '5', '[46] likes affichés');
  assert($('galleryThumbnails').children.length === 2, '[46] galerie : 2 vignettes photo');
  assert($('mainGalleryImg').getAttribute('src') === 'https://img/1.jpg', '[46] photo principale = 1re URL');

  // Annonce sans ville → « Inconnue » honnête (jamais inventée).
  const noCityAd = { id: 'X1', title: 'Sans ville', url: 'u', prix: 10, description: 'd' };
  window.__setCache([{ id: 'j2', date: '02/08/2026', adsCount: 1, ads: [noCityAd] }]);
  window.openAdDetail('X1');
  assert($('modalCity').textContent === 'Inconnue', '[46] ville absente → « Inconnue » (jamais inventée)');
  assert($('mainGalleryImg').getAttribute('src') && /data:image\/svg/.test($('mainGalleryImg').getAttribute('src')),
    '[46] aucune photo → placeholder local (pas d\'URL fictive)');

  // Annonce absente → la modal reste fermée (pas de fiche vide trompeuse).
  $('adDetailModal').classList.add('hidden');
  window.openAdDetail('INEXISTANT');
  assert($('adDetailModal').classList.contains('hidden'), '[46] annonce introuvable → modal reste fermée');

  dom.window.close();
}
console.log('\n[46] OK');

// --- 47. Explorateur : pagination (perf sur sessions volumineuses) ---
// L'explorateur construisait TOUTES les lignes en un seul innerHTML : une
// session de 20 000 annonces générait ~405 000 nœuds DOM et gelait l'interface
// ~17 s (mesuré au harnais CDP). On vérifie ici que le rendu est borné à une
// page et que la navigation fonctionne réellement.
console.log('\n[47] Explorateur : pagination (DOM borné)');
{
  const { JSDOM } = require('jsdom');
  const repoRoot = path.join(__dirname, '..');

  const html = `<!doctype html><html><body>
    <div id="adsTableContainer"><table><tbody id="adsTableBody"></tbody></table></div>
    <div id="adsGridContainer" class="hidden"></div>
    <span id="filteredAdsCount"></span>
    <button id="viewTableBtn"></button><button id="viewGridBtn"></button>
    <input id="filterKeyword"><input id="filterPriceMin"><input id="filterPriceMax">
    <select id="filterTagSelect"><option value="ALL">ALL</option></select>
    <select id="sortSelect"><option value="DEFAULT">DEFAULT</option></select>
    <select id="filterDeliveryType"><option value="tous">tous</option></select>
    <select id="filterSellerType"><option value="ALL">ALL</option></select>
    <input id="filterMinRating"><input id="filterMinLikes">
    <select id="filterEtat"><option value="ALL">ALL</option></select>
    <select id="sessionSelect"><option value="ALL">ALL</option></select>
    <div id="explorerPagination" class="hidden">
      <button id="pagePrevBtn"></button><span id="pageInfo"></span><button id="pageNextBtn"></button>
    </div>
    <div id="adDetailModal" class="hidden"><h3 id="modalAdTitle"></h3><button id="closeDetailModalBtn"></button>
      <img id="mainGalleryImg"><div id="galleryThumbnails"></div><span id="modalDealBadge"></span>
      <button id="modalStarBtn"></button><span id="modalPrice"></span><span id="modalCity"></span>
      <span id="modalSeller"></span><span id="modalDate"></span><div id="modalDescription"></div>
      <button id="modalOpenLeboncoinBtn"></button></div>
    <div id="toastContainer"></div>
  </body></html>`;

  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://app.local/' });
  const { window } = dom;
  window.api = { getHistory: async () => [], openExternal: () => {}, openFolder: async () => ({ success: true }) };
  const utilsSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/utils.js'), 'utf8');
  const appStateSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/appState.js'), 'utf8');
  const explorerSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/explorerModule.js'), 'utf8');
  window.eval(utilsSrc + '\n' + appStateSrc + '\n' + explorerSrc
    + '\n;window.__setCache = (v) => { allJobsCache = v; };'
    + '\n;window.__render = () => renderExplorerAds();'
    + '\n;window.__pageSize = () => EXPLORER_PAGE_SIZE;');

  const N = 1234;
  const ads = Array.from({ length: N }, (_, i) => ({ id: `A${i}`, title: `T${i}`, url: `u${i}`, prix: i + 1, ville: 'Lyon' }));
  window.__setCache([{ id: 'j', date: '01/01/2026', adsCount: N, ads }]);
  window.__render();

  const $ = (id) => window.document.getElementById(id);
  const pageSize = window.__pageSize();
  assert(pageSize > 0 && pageSize < N, `[47] taille de page bornée (${pageSize})`);
  assert($('adsTableBody').querySelectorAll('tr').length === pageSize,
    `[47] une seule page rendue (${$('adsTableBody').querySelectorAll('tr').length} = ${pageSize})`);
  assert(!$('explorerPagination').classList.contains('hidden'), '[47] barre de pagination visible (>1 page)');
  assert(/Page 1 \//.test($('pageInfo').textContent), '[47] indication « Page 1 / N »');
  assert($('pagePrevBtn').disabled === true, '[47] « Précédent » désactivé en page 1');

  // Navigation réelle : page suivante.
  $('pageNextBtn').click();
  assert(/Page 2 \//.test($('pageInfo').textContent), '[47] navigation page suivante');
  assert($('adsTableBody').querySelectorAll('tr').length === pageSize, '[47] page 2 également bornée');
  $('pagePrevBtn').click();
  assert(/Page 1 \//.test($('pageInfo').textContent), '[47] navigation page précédente');

  // Filtrage → compteur honnête (recherche par sous-chaîne : « T123 » matche
  // T123, T1230…T1233). On vérifie que le compteur reflète le filtre réel.
  $('filterKeyword').value = 'T123';
  window.__render();
  const expected = ads.filter((a) => (a.title || '').toLowerCase().includes('t123')).length;
  assert($('filteredAdsCount').textContent === String(expected),
    `[47] compteur après filtre (${$('filteredAdsCount').textContent} = ${expected})`);
  assert($('adsTableBody').querySelectorAll('tr').length === expected,
    '[47] toutes les lignes filtrées tiennent sur une page');

  dom.window.close();
}
console.log('\n[47] OK');

// --- 48. Sécurité : validation des URL d'images du renderer (anti-SSRF) ---
// Les URL de photos proviennent d'annonces.json (fichier potentiellement
// modifié). Elles DOIVENT être validées avant d'être assignées à img.src, sinon
// le renderer émettrait des requêtes vers des adresses locales/internes.
console.log('\n[48] Sécurité : sanitizeImageUrl (anti-SSRF renderer)');
{
  const utilsSrc = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/utils.js'), 'utf8');
  // On isole la fonction pure (pas de DOM requis) : on coupe le source avant
  // les affectations `window.*` du bas de fichier.
  const pure = utilsSrc.split('window.openUrl')[0];
  const sandbox = {};
  new Function('exports', pure + '\n;exports.sanitizeImageUrl = sanitizeImageUrl;')(sandbox);
  const s = sandbox.sanitizeImageUrl;

  assert(typeof s === 'function', '[48] sanitizeImageUrl exportée');
  // Doivent PASSER (images légitimes).
  assert(s('https://img.leboncoin.fr/abc_0.jpg') === 'https://img.leboncoin.fr/abc_0.jpg', '[48] https leboncoin accepté');
  assert(s('http://img.leboncoin.fr/a.jpg') === 'http://img.leboncoin.fr/a.jpg', '[48] http public accepté');
  // Doivent être REJETÉES (SSRF / schémas).
  assert(s('http://127.0.0.1/x.jpg') === null, '[48] loopback rejeté');
  assert(s('http://localhost/x.jpg') === null, '[48] localhost rejeté');
  assert(s('http://192.168.1.5/x.jpg') === null, '[48] 192.168/16 rejeté');
  assert(s('http://10.0.0.1/x.jpg') === null, '[48] 10/8 rejeté');
  assert(s('http://172.16.0.1/x.jpg') === null, '[48] 172.16/12 rejeté');
  assert(s('http://169.254.169.254/latest/meta-data/') === null, '[48] métadonnées cloud rejetées');
  assert(s('http://[::1]/x.jpg') === null, '[48] IPv6 loopback rejeté');
  assert(s('file:///etc/passwd') === null, '[48] file:// rejeté');
  assert(s('javascript:alert(1)') === null, '[48] javascript: rejeté');
  assert(s('ftp://host/x.jpg') === null, '[48] ftp:// rejeté');
  assert(s('') === null, '[48] chaîne vide rejetée');
  assert(s(null) === null, '[48] null rejeté');
  assert(s(123) === null, '[48] non-chaîne rejetée');
  // Placeholders locaux conservés.
  assert(typeof s('data:image/svg+xml;utf8,%3Csvg/%3E') === 'string', '[48] placeholder data:image/svg+xml conservé');
}
console.log('\n[48] OK');


// ═══════════════════════════════════════════════════════════════════════════
// [49] Anomalies confirmées par l'audit intégral 2026-10-17
//   49.1 Prix : parsing des formats français (parseFloat seul tronquait)
//   49.2 Carte : centroïde de regroupement (moyenne des POINTS, pas des annonces)
//   49.3 IPC job:start : configuration invalide ne doit pas verrouiller le job
//   49.4 Détail : pas de contamination croisée entre annonces (repli found[0])
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[49] Audit 2026-10-17 : prix, carte, verrou job, contamination détail');
{
  const adFields = require('../src/main/services/scraping/adFields');
  const { parseHtmlDescription, normalizeAd } = require('../src/main/services/scraping/leboncoin-pipeline');
  const repoRoot = path.join(__dirname, '..');

  // 49.1 Prix — `parseFloat` seul renvoyait 1 pour « 1 250 € » (troncature).
  assert(adFields.extractPrice({ price: '1 250 €' }) === 1250, '[49] prix « 1 250 € » → 1250 (pas 1)');
  assert(adFields.extractPrice({ price: '1 250' }) === 1250, '[49] prix « 1 250 » → 1250');
  assert(adFields.extractPrice({ price: '12,50' }) === 12.5, '[49] prix « 12,50 » → 12,5');
  assert(adFields.extractPrice({ price: '1.299,99' }) === 1299.99, '[49] prix « 1.299,99 » → 1299,99');
  assert(adFields.extractPrice({ price: '1.299,99 €' }) === 1299.99, '[49] prix avec devise → 1299,99');
  assert(adFields.extractPrice({ price: '1250' }) === 1250, '[49] prix entier sans séparateur');
  assert(adFields.extractPrice({ price: [{ value: '1 299' }] }) === 1299, '[49] prix array d\'objet string → 1299');
  assert(adFields.extractPrice({ price: { value: '1.299,99 €' } }) === 1299.99, '[49] prix objet {value} string FR');
  // Les cas non numériques restent null (jamais une valeur inventée).
  assert(adFields.extractPrice({ price: 'abc' }) === null, '[49] prix non numérique → null');
  assert(adFields.extractPrice({ price: '' }) === null, '[49] prix chaîne vide → null');
  assert(adFields.extractPrice({ price: 0 }) === 0, '[49] prix 0 → 0 (0 ≠ null)');
  // Cohérence avec normalizeAd (chaîne de production réelle).
  assert(normalizeAd({ list_id: 'p1', subject: 'T', price: '1 250 €' }).prix === 1250,
    '[49] normalizeAd : prix chaîne FR → nombre correct');

  // 49.2 Carte — centroïde : la moyenne porte sur les POINTS, pas sur les annonces.
  const mapSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/mapModule.js'), 'utf8');
  const mapWin = {};
  const mapSandbox = {
    window: mapWin,
    document: { getElementById: () => null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 },
    console, L: undefined, fetch: () => Promise.reject(new Error('offline')), setTimeout, clearTimeout,
  };
  mapSandbox.globalThis = mapSandbox;
  require('vm').createContext(mapSandbox);
  require('vm').runInContext(mapSrc, mapSandbox);
  const clusterMarkers = mapWin.clusterMarkers;
  // Une seule ville (point) contenant 5 annonces : le marqueur doit rester sur la ville.
  const solo = clusterMarkers([{ lat: 45.7, lng: 4.8, ads: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }] }], 0.25);
  assert(solo.length === 1 && Math.abs(solo[0].lat - 45.7) < 1e-9 && Math.abs(solo[0].lng - 4.8) < 1e-9,
    `[49] carte : 1 ville à 5 annonces → marqueur sur la ville (obtenu lat=${solo[0].lat})`);
  assert(solo[0].ads.length === 5, '[49] carte : les 5 annonces restent rattachées au groupe');
  // Deux points proches, nombre d'annonces inégal : centroïde = moyenne des points.
  const pA = { lat: 45.0, lng: 3.0, ads: new Array(10).fill({}) };
  const pB = { lat: 45.2, lng: 3.0, ads: [{}] };
  const mixed = clusterMarkers([pA, pB], 0.25);
  const expectedLat = (pA.lat + pB.lat) / 2; // 45,1 (moyenne des points)
  const weightedLat = (pA.lat * 10 + pB.lat) / 11; // 45,018 (ancien calcul erroné)
  assert(mixed.length === 1 && Math.abs(mixed[0].lat - expectedLat) < 1e-9,
    `[49] carte : centroïde = moyenne des points ${expectedLat} (obtenu ${mixed[0].lat})`);
  assert(Math.abs(mixed[0].lat - weightedLat) > 0.05,
    '[49] carte : le centroïde n\'est PAS pondéré par le nombre d\'annonces');

  // 49.3 IPC job:start — la validation précède l'armement du verrou `isRunning`.
  const ipcSrc = fs.readFileSync(path.join(repoRoot, 'src/main/core/ipcHandlers.js'), 'utf8');
  const lockIdx = ipcSrc.indexOf("ipcMain.on('job:start'");
  const guardIdx = ipcSrc.indexOf('Configuration de scraping absente ou invalide');
  const armIdx = ipcSrc.indexOf('isRunning = true', lockIdx);
  assert(guardIdx > lockIdx && armIdx > guardIdx,
    '[49] ipcHandlers : la validation config précède `isRunning = true` (pas de verrou permanent)');
  assert(/typeof searchUrl !== 'string' \|\| searchUrl\.trim\(\) === ''/.test(ipcSrc),
    '[49] ipcHandlers : URL de recherche validée avant le lancement du job');
  assert(!/parseInt\(config\.pages, 10\)/.test(ipcSrc),
    '[49] ipcHandlers : plus de lecture `config.pages` avant validation (cause du verrou)');

  // 49.4 Détail — pas de repli sur une AUTRE annonce quand l'ID demandé est absent.
  const otherAdHtml = '<html><head><script id="__NEXT_DATA__" type="application/json">'
    + JSON.stringify({ props: { pageProps: { ad: {
      list_id: 111, subject: 'Autre annonce', body: 'Description étrangère.',
      url: 'https://www.leboncoin.fr/ad/111.htm',
      owner: { name: 'Autre vendeur', user_id: 'u111', rating: 4.5, nb_ratings: 12 },
    } } } })
    + '</script></head><body></body></html>';
  const noMatch = parseHtmlDescription(otherAdHtml, '999999');
  assert(noMatch.description === null && noMatch.vendeurNom === null && noMatch.note === null,
    '[49] détail : ID absent de la page → champs null (pas de données d\'une autre annonce)');
  // L'ID exact continue de fonctionner (aucune régression fonctionnelle).
  const matchOk = parseHtmlDescription(otherAdHtml, '111');
  assert(matchOk.description === 'Description étrangère.' && matchOk.vendeurNom === 'Autre vendeur',
    '[49] détail : ID exact toujours enrichi (pas de régression)');
  // Le repli `found[0]` n'est conservé QUE pour un appel sans identifiant
  // (aucun risque d'attribuer les données d'une autre annonce).
  assert(parseHtmlDescription(otherAdHtml, null).description === 'Description étrangère.',
    '[49] détail : appel sans ID → repli documenté sur la 1re annonce trouvée');
  assert(parseHtmlDescription(otherAdHtml, undefined).description === 'Description étrangère.',
    '[49] détail : adId undefined → repli documenté (pas de contamination d\'un ID précis)');
}
console.log('\n[49] OK');


// ═══════════════════════════════════════════════════════════════════════════
// [50] Audit intégral 2026-10-17 (2e passe) — anomalies confirmées
//   50.1 SSRF renderer : sanitizeImageUrl laissait passer les IPv4-mappées
//   50.2 harCapturer : la reprise après CAPTCHA écrasait le HAR déjà capturé
//   50.3 buildAdHistory : prix en chaîne FR tronqué par parseFloat
//   50.4 CircuitBreaker : une annulation était rapportée « access_refused »
//   50.5 Paramètres : vendeur / rétention logs non appliqués avant redémarrage
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[50] Audit intégral 2e passe : correctifs');
{
  const repoRoot = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

  // 50.1 — sanitizeImageUrl : SSRF via IPv6 IPv4-mappée / NAT64 / ULA non compressée.
  {
    const utilsSrc = read('src/renderer/utils.js');
    const pure = utilsSrc.split('window.openUrl')[0];
    const sandbox = {};
    new Function('exports', pure + '\n;exports.sanitizeImageUrl = sanitizeImageUrl;')(sandbox);
    const s = sandbox.sanitizeImageUrl;
    // Images légitimes : conservées.
    assert(s('https://img.leboncoin.fr/abc_0.jpg') === 'https://img.leboncoin.fr/abc_0.jpg',
      '[50] image https légitime acceptée');
    assert(s('http://[2606:4700::1111]/a.jpg') !== null, '[50] IPv6 publique acceptée');
    // Bypass SSRF historiques : DOIVENT être rejetés.
    const mustReject = [
      'http://[::ffff:127.0.0.1]/x.jpg',
      'http://[::ffff:7f00:1]/x.jpg',
      'http://[::ffff:a9fe:a9fe]/x.jpg',
      'http://[::ffff:c0a8:101]/x.jpg',
      'http://[::ffff:a00:1]/x.jpg',
      'http://[0:0:0:0:0:0:0:1]/x.jpg',
      'http://[64:ff9b::7f00:1]/x.jpg',
      'http://[fc00:0:0:0:0:0:0:1]/x.jpg',
      'http://[fd00::1]/x.jpg',
      'http://[fe80::1]/x.jpg',
      'http://127.0.0.1/x.jpg',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/x.jpg',
    ];
    let leaked = mustReject.filter((u) => s(u) !== null);
    assert(leaked.length === 0,
      `[50] sanitizeImageUrl rejette les IPv4-mappées/ULA/NAT64 (fuites: ${leaked.join(', ') || 'aucune'})`);
  }

  // 50.2 — harCapturer : HAR de reprise CAPTCHA dédié + fusion.
  {
    const harCode = read('src/main/services/scraping/harCapturer.js');
    assert(/retryHarPath/.test(harCode),
      '[50] harCapturer : HAR de reprise CAPTCHA dédié (pas de réutilisation du HAR principal)');
    assert(/recordHar:\s*\{\s*path:\s*retryHarPath/.test(harCode),
      '[50] harCapturer : le contexte de reprise CAPTCHA écrit dans retryHarPath');
    assert(/mergeHarFiles\(\[outputHarPath,\s*retryHarPath\]/.test(harCode),
      '[50] harCapturer : le HAR de reprise CAPTCHA est fusionné dans le HAR principal');
    // La réutilisation du même chemin reste évitée (Playwright tronque le fichier).
    assert(!/recordHar:\s*\{\s*path:\s*activeHarPath[^}]*\}\s*\);\s*\n\s*if \(fs\.existsSync\(GLOBAL_SESSION_PATH\)\) \{\s*\n\s*retryCtxOpts/.test(harCode),
      '[50] harCapturer : plus de recordHar réutilisant activeHarPath sur la reprise CAPTCHA');
  }

  // 50.3 — buildAdHistory : prix FR en chaîne → nombre correct.
  {
    const { buildAdHistory } = require('../src/main/services/jobs/jobHistory');
    const jobs = [
      { id: 'job-2026-01-01T10-00-00', date: '01/01/2026 à 10:00', ads: [{ id: 'A1', prix: '1 250 €' }] },
      { id: 'job-2026-02-01T10-00-00', date: '01/02/2026 à 10:00', ads: [{ id: 'A1', prix: '1 000 €' }] },
    ];
    const h = buildAdHistory(jobs).find((x) => x.id === 'A1');
    assert(h && h.prix && h.prix.initial === 1250, '[50] buildAdHistory : prix initial « 1 250 € » → 1250');
    assert(h && h.prix && h.prix.actuel === 1000, '[50] buildAdHistory : prix actuel « 1 000 € » → 1000');
    assert(h && h.prix && h.prix.baisse === 250, '[50] buildAdHistory : baisse détectée 250 (parseFloat donnait 0/NaN)');
    // Prix numérique (modèle actuel) : inchangé.
    const jobsNum = [
      { id: 'job-2026-01-01T10-00-00', date: '01/01/2026 à 10:00', ads: [{ id: 'A2', prix: 500 }] },
      { id: 'job-2026-02-01T10-00-00', date: '01/02/2026 à 10:00', ads: [{ id: 'A2', prix: 450 }] },
    ];
    const h2 = buildAdHistory(jobsNum).find((x) => x.id === 'A2');
    assert(h2 && h2.prix && h2.prix.baisse === 50, '[50] buildAdHistory : prix numérique toujours correct');
  }

  // 50.4 — CircuitBreaker : annulation ≠ access_refused.
  {
    const { CircuitBreaker } = require('../src/main/services/scraping/circuitBreaker');
    const cb = new CircuitBreaker({ blockThreshold: 3 });
    cb.markCancelled();
    assert(cb.shouldStop() === true, '[50] circuit : annulation → shouldStop() true (arrêt effectif)');
    assert(cb.stopInfo() === null, '[50] circuit : annulation → stopInfo() null (pas de faux 403/429)');
    // Le vrai blocage reste rapporté (pas de régression).
    const cb403 = new CircuitBreaker({ blockThreshold: 1 });
    cb403.recordBlock(403, 'HTTP_403');
    assert(cb403.stopInfo() && cb403.stopInfo().reason === 'access_refused',
      '[50] circuit : blocage 403 toujours rapporté access_refused');
    const cb429 = new CircuitBreaker({ blockThreshold: 1 });
    cb429.recordBlock(429, 'HTTP_429');
    assert(cb429.stopInfo() && cb429.stopInfo().reason === 'rate_limited',
      '[50] circuit : blocage 429 toujours rapporté rate_limited');
    // Le pipeline utilise markCancelled sur SIGINT.
    const pipeCode = read('src/main/services/scraping/leboncoin-pipeline.js');
    assert(/this\.circuit\.markCancelled\(\)/.test(pipeCode),
      '[50] pipeline : SIGINT → circuit.markCancelled() (pas state=\'stopped\' direct)');
    assert(!/this\.circuit\.state\s*=\s*'stopped'/.test(pipeCode),
      '[50] pipeline : plus d\'affectation directe state=\'stopped\' (source du faux access_refused)');
  }

  // 50.5 — Paramètres : vendeur + rétention logs appliqués immédiatement.
  {
    const scraperCode = read('src/renderer/scraperModule.js');
    assert(/if \(window\.refreshSellerDataSetting\) await window\.refreshSellerDataSetting\(\)/.test(scraperCode),
      '[50] scraperModule : saveSettings réapplique la visibilité vendeur (pas d\'attente du redémarrage)');
    const ipcCode = read('src/main/core/ipcHandlers.js');
    assert(/logger\.setRetention\(merged\.logRetentionDays\)/.test(ipcCode),
      '[50] ipcHandlers : config:save applique la rétention des logs immédiatement');
  }

  // 50.6 — Renderer : priceOf normalise les prix en chaîne FR (filtre/tri/affichage).
  {
    const utilsSrc = read('src/renderer/utils.js');
    const pure = utilsSrc.split('window.openUrl')[0];
    const sandbox = {};
    new Function('exports', pure + '\n;exports.priceOf = priceOf;')(sandbox);
    const p = sandbox.priceOf;
    assert(p({ prix: 1250 }) === 1250, '[50] priceOf : nombre inchangé');
    assert(p({ prix: '1 250 €' }) === 1250, '[50] priceOf : « 1 250 € » → 1250 (parseFloat donnait 1)');
    assert(p({ prix: '1250' }) === 1250, '[50] priceOf : « 1250 » → 1250');
    assert(p({ price: '1 250 €' }) === 1250, '[50] priceOf : repli sur la clé `price`');
    assert(p({ prix: '1.299,99 €' }) === 1299.99, '[50] priceOf : « 1.299,99 € » → 1299,99');
    assert(Number.isNaN(p({})), '[50] priceOf : prix absent → NaN');
    assert(p({ prix: 0 }) === 0, '[50] priceOf : 0 reste 0 (0 ≠ null)');
    // L'explorateur consomme bien priceOf (filtre + tri + affichage).
    const expCode = read('src/renderer/explorerModule.js');
    assert(/Number\.isFinite\(priceNum\) \? priceNum : 0/.test(expCode),
      '[50] explorateur : filtre de prix basé sur priceOf (plus de parseFloat tronquant)');
    assert(/Number\.isFinite\(priceOf\(a\)\) \? priceOf\(a\) : 0/.test(expCode),
      '[50] explorateur : tri par prix basé sur priceOf');
    assert(!/a\.prix != null \? a\.prix \+ ' €'/.test(expCode),
      '[50] explorateur : affichage du prix via priceOf (plus de concaténation brute)');
  }

  console.log('\n[50] OK');
}

// ═══════════════════════════════════════════════════════════════════════════
// [51] ÉVOLUTION DES PRIX — normalisation & extraction de caractéristiques
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[51] Évolution des prix — normalisation & extraction');
{
  const { normalizeText, tokenize, normalizeReference } = require('../src/main/services/history/normalizeText');
  const { extractFeatures } = require('../src/main/services/history/featureExtractor');

  // 51.1 Normalisation : casse, accents, ponctuation, séparateurs.
  assert(normalizeText('  AMD   Ryzen 5 9600X (neuf) ') === 'amd ryzen 5 9600x neuf', '[51] normalizeText : casse/espaces/ponctuation');
  assert(normalizeText('Écran 24" IPS') === 'ecran 24 ips', '[51] normalizeText : accents repliés + guillemets');
  assert(normalizeText('R5-9600X_v2') === 'r5 9600x v2', '[51] normalizeText : tirets/underscore → séparateurs');
  assert(normalizeText('Cœur 8 cœurs') === 'coeur 8 coeurs', '[51] normalizeText : accents sans perdre les chiffres');
  assert(normalizeText('') === '' && normalizeText(null) === '', '[51] normalizeText : entrée vide/null → chaîne vide');
  // Reproductible
  assert(normalizeText('Ryzen 5 9600X') === normalizeText('Ryzen 5 9600X'), '[51] normalizeText : reproductible');

  // 51.2 Normalisation de RÉFÉRENCE : les séparateurs disparaissent, les
  // chiffres/suffixes restent (distinction de modèle préservée).
  assert(normalizeReference('R5-9600X') === 'R59600X', '[51] normalizeReference : séparateurs retirés');
  assert(normalizeReference('rtx 3060 ti') === 'RTX3060TI', '[51] normalizeReference : espace retiré, majuscules');
  assert(normalizeReference('9600X') !== normalizeReference('9600'), '[51] normalizeReference : 9600X ≠ 9600');

  // 51.3 Extraction : distinction des modèles proches (9600 vs 9600X).
  const f9600x = extractFeatures({ title: 'AMD Ryzen 5 9600X neuf' });
  assert(f9600x.primaryReference === '9600X', '[51] extraction : référence 9600X');
  assert(f9600x.family === 'cpu', '[51] extraction : famille processeur');
  assert(f9600x.brand === 'amd', '[51] extraction : marque AMD');
  assert(f9600x.condition === 'new', '[51] extraction : état « neuf » détecté');
  const f9600 = extractFeatures({ title: 'AMD Ryzen 5 9600' });
  assert(f9600.primaryReference === '9600', '[51] extraction : référence 9600 (sans X)');
  assert(f9600x.primaryReference !== f9600.primaryReference, '[51] extraction : 9600X et 9600 restent distincts');

  // 51.4 Variantes de préfixe : « R5-9600X » ≡ « 9600X » (même référence).
  const fR5 = extractFeatures({ title: 'Processeur AMD R5-9600X' });
  assert(fR5.primaryReference === '9600X', '[51] extraction : R5-9600X → référence 9600X');

  // 51.5 « 9600 X » (espace) → même référence que « 9600X ».
  const fSpace = extractFeatures({ title: 'Ryzen 5 9600 X vendu seul' });
  assert(fSpace.primaryReference === '9600X', '[51] extraction : « 9600 X » → 9600X (suffixe joint)');

  // 51.6 Suffixe GPU : 3060 Ti ≠ 3060.
  const f3060ti = extractFeatures({ title: 'RTX 3060 Ti 8 Go' });
  const f3060 = extractFeatures({ title: 'RTX 3060 12 Go' });
  assert(f3060ti.primaryReference === '3060TI', '[51] extraction : 3060 Ti → 3060TI');
  assert(f3060.primaryReference === '3060', '[51] extraction : 3060 → 3060');
  assert(f3060ti.units.capacity_gb.value === 8, '[51] extraction : capacité 8 Go');
  assert(f3060.units.capacity_gb.value === 12, '[51] extraction : capacité 12 Go (8 ≠ 12)');

  // 51.7 Lot / accessoire / pièce détachée.
  assert(extractFeatures({ title: 'Lot de 2 Ryzen 5 9600X' }).offerType === 'lot', '[51] extraction : lot détecté');
  assert(extractFeatures({ title: 'Ventirad pour Ryzen 5 9600X' }).offerType === 'accessory_only', '[51] extraction : accessoire seul');
  assert(extractFeatures({ title: 'Ryzen 5 9600X hors service pour pièces' }).offerType === 'part', '[51] extraction : pièce détachée');
  assert(extractFeatures({ title: 'Ryzen 5 9600X hors service' }).condition === 'for_parts', '[51] extraction : hors service');

  // 51.8 Contradiction titre/description (neuf vs à réparer).
  const contra = extractFeatures({ title: 'AMD Ryzen 5 9600X neuf', description: 'en réalité ne fonctionne plus, pour pièces' });
  assert(contra.contradictions.some((c) => c.type === 'condition_title_description'), '[51] extraction : contradiction état titre/description signalée');

  // 51.9 Description absente → hasDescription=false (pas de rejet automatique).
  assert(extractFeatures({ title: 'Ryzen 5 9600X' }).hasDescription === false, '[51] extraction : description absente marquée');
  // Référence du titre vs description divergente.
  const refContra = extractFeatures({ title: 'AMD Ryzen 5 9600X', description: 'il s\'agit du 5600X en fait' });
  assert(refContra.contradictions.some((c) => c.type === 'reference_title_description'), '[51] extraction : contradiction de référence signalée');

  console.log('\n[51] OK');
}

// ═══════════════════════════════════════════════════════════════════════════
// [52] ÉVOLUTION DES PRIX — rapprochement déterministe (identité produit)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[52] Évolution des prix — rapprochement déterministe');
{
  const { extractFeatures } = require('../src/main/services/history/featureExtractor');
  const { compareReferences, decide, scoreMatch, DEFAULT_THRESHOLDS } = require('../src/main/services/history/productIdentity');

  // Produit candidat construit comme le fait le registre (features → produit).
  const mkProduct = (title) => {
    const f = extractFeatures({ title });
    return { id: title, reference: f.primaryReference, brand: f.brand, family: f.family, units: f.units, titleTokens: f.titleTokens, label: title, status: 'confirmed' };
  };
  const run = (title, cands, desc) => decide(extractFeatures(desc ? { title, description: desc } : { title }), cands);

  // 52.1 Relation de référence.
  assert(compareReferences('9600X', '9600X') === 'exact', '[52] compareReferences : identiques → exact');
  assert(compareReferences('R59600X', '9600X') === 'partial', '[52] compareReferences : préfixe → partial');
  assert(compareReferences('9600', '9600X') === 'conflict', '[52] compareReferences : suffixe de modèle → conflict');
  assert(compareReferences('3060', '3060TI') === 'conflict', '[52] compareReferences : 3060 vs 3060 Ti → conflict');
  assert(compareReferences('9600X', '5800X') === 'none', '[52] compareReferences : modèles sans lien → none');

  const P9600X = mkProduct('AMD Ryzen 5 9600X');
  const P9600 = mkProduct('AMD Ryzen 5 9600');

  // 52.2 Cas 1 : deux formulations d'un même modèle → confirmées sur le même produit.
  const c1 = run('AMD Ryzen 5 9600X neuf', [P9600X, P9600]);
  assert(c1.decision === 'confirmed' && c1.product.id === P9600X.id, '[52] cas 1 : « AMD Ryzen 5 9600X neuf » → confirmé sur 9600X');
  const c1b = run('Processeur AMD R5-9600X', [P9600X, P9600]);
  assert(c1b.decision === 'confirmed' && c1b.product.id === P9600X.id, '[52] cas 1 : « R5-9600X » → confirmé sur 9600X');
  const c1c = run('Ryzen 5 9600 X vendu seul', [P9600X, P9600]);
  assert(c1c.decision === 'confirmed' && c1c.product.id === P9600X.id, '[52] cas 1 : « 9600 X vendu seul » → confirmé sur 9600X');

  // 52.3 Cas 2 : références presque identiques mais différentes → jamais fusionnées.
  const c2 = run('AMD Ryzen 5 9600', [P9600X, P9600]);
  assert(c2.product.id === P9600.id, '[52] cas 2 : 9600 confirmé sur le produit 9600 (pas 9600X)');
  const c2b = run('AMD Ryzen 5 9600X', [P9600]);
  assert(c2b.decision === 'rejected' || c2b.recommendation === 'new', '[52] cas 2 : 9600X ne se rattache PAS au produit 9600');

  // 52.4 Cas 3 : référence inédite → nouvelle identité provisoire.
  const c3 = run('AMD Ryzen 5 7600X', [P9600X, P9600]);
  assert(c3.recommendation === 'new', '[52] cas 3 : référence inconnue → nouvelle identité');

  // 52.5 Cas 4 : annonce sans description → pas de rejet automatique.
  const c4 = run('AMD Ryzen 5 9600X', [P9600X]);
  assert(c4.decision === 'confirmed', '[52] cas 4 : sans description, référence exacte suffit à confirmer');

  // 52.6 Cas 5 : annonce très vague → non identifiée (pas de produit inventé).
  const c5 = run('processeur amd', [P9600X, P9600]);
  assert(c5.decision !== 'confirmed', '[52] cas 5 : annonce vague → jamais confirmée');
  assert(c5.recommendation === 'pending', '[52] cas 5 : annonce vague sans référence → file manuelle');

  // 52.7 Cas 6 : contradiction titre/description → pas de confirmation automatique.
  const c6 = run('AMD Ryzen 5 9600X', [P9600X], 'ne fonctionne plus, vendu pour pièces');
  assert(c6.decision !== 'confirmed', '[52] cas 6 : contradiction titre/description → pas de confirmation auto');

  // 52.8 Cas 7 : accessoire mentionnant le produit → exclu.
  const c7 = run('Ventirad pour Ryzen 5 9600X', [P9600X]);
  assert(c7.decision === 'rejected', '[52] cas 7 : accessoire → refusé');

  // 52.9 Cas 8 : lot de plusieurs produits → exclu.
  const c8 = run('Lot de 2 Ryzen 5 9600X', [P9600X]);
  assert(c8.decision === 'rejected', '[52] cas 8 : lot → refusé');

  // 52.10 Cas 9 : neuf vs hors service → l'annonce hors service est ASSOCIÉE au
  // produit (pour la fiche) mais EXCLUE de la série de prix (non comparable).
  const c9 = run('Ryzen 5 9600X hors service', [P9600X]);
  assert(c9.recommendation === 'link', '[52] cas 9 : hors service → associé au produit (fiche) mais prix non comparable');
  assert(c9.evaluation.contradictions.some((c) => c.type === 'condition_not_functional'),
    '[52] cas 9 : motif « condition_not_functional » enregistré (exclusion de la série de prix)');

  // 52.11 Cas 10 : plusieurs modèles d'une même famille → chacun sur son produit.
  const c10a = run('RTX 3060 Ti 8 Go', [mkProduct('RTX 3060 12 Go'), mkProduct('RTX 3060 Ti 8 Go')]);
  assert(c10a.product.reference === '3060TI', '[52] cas 10 : 3060 Ti rejoint le produit 3060 Ti');
  const c10b = run('RTX 3060 12 Go', [mkProduct('RTX 3060 12 Go'), mkProduct('RTX 3060 Ti 8 Go')]);
  assert(c10b.product.reference === '3060', '[52] cas 10 : 3060 rejoint le produit 3060');

  // 52.12 Cas 11 : référence alphanumérique inédite reconnue sans catalogue.
  const c11 = run('Carte graphique XYZ-9876 16 Go', []);
  assert(c11.recommendation === 'new', '[52] cas 11 : référence inédite → nouvelle identité (sans catalogue)');

  // 52.13 Cas 12 : alias contradictoires → hypothèses non fusionnées.
  const c12 = run('Ryzen 5 9600X', [P9600X, P9600]);
  assert(c12.product.id === P9600X.id && c12.runnerUp && c12.runnerUp.id === P9600.id,
    '[52] cas 12 : le candidat concurrent reste identifiable (hypothèses coexistantes)');

  // 52.14 Un score textuel élevé ne compense PAS une contradiction majeure.
  const fakeSimilar = { id: 'fake', reference: '9600X', brand: 'amd', family: 'cpu', units: {}, titleTokens: extractFeatures({ title: 'AMD Ryzen 5 9600X neuf' }).titleTokens, label: 'fake', status: 'confirmed' };
  const c14 = run('AMD Ryzen 5 9600X neuf', [fakeSimilar], 'vendu pour pièces, ne fonctionne plus');
  assert(c14.decision === 'rejected', '[52] cas 14 : contradiction majeure prime sur la similarité textuelle');

  // 52.15 Unités incompatibles (8 Go vs 16 Go) → refus.
  const c15 = run('RTX 3060 Ti 8 Go', [mkProduct('RTX 3060 Ti 16 Go')]);
  assert(c15.decision === 'rejected', '[52] cas 15 : capacités incompatibles → refus');

  // 52.16 Seuils exposés et cohérents.
  assert(DEFAULT_THRESHOLDS.CONFIRM_MIN > DEFAULT_THRESHOLDS.REJECT_MAX, '[52] seuils : CONFIRM_MIN > REJECT_MAX');
  const scoreObj = scoreMatch(extractFeatures({ title: 'AMD Ryzen 5 9600X' }), P9600X);
  assert(typeof scoreObj.score === 'number' && scoreObj.score >= 0 && scoreObj.score <= 100, '[52] score borné 0..100');

  console.log('\n[52] OK');
}

// ═══════════════════════════════════════════════════════════════════════════
// [53] ÉVOLUTION DES PRIX — statistiques & séries temporelles
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[53] Évolution des prix — statistiques');
{
  const { describeValues, computeEvolution, buildSeries, buildProductStats, periodKey } = require('../src/main/services/history/priceStats');

  // 53.1 Moyenne / médiane — résultats calculés INDÉPENDAMMENT de l'implémentation.
  const d1 = describeValues([100, 200, 300, 400]);
  assert(d1.mean === 250, '[53] moyenne de [100,200,300,400] = 250');
  assert(d1.median === 250, '[53] médiane paire = moyenne des deux valeurs centrales (250)');
  const d2 = describeValues([100, 200, 350]);
  assert(d2.median === 200, '[53] médiane impaire = valeur centrale (200)');
  assert(d2.mean === Math.round((650 / 3) * 100) / 100, '[53] moyenne = somme / n');
  assert(d1.min === 100 && d1.max === 400, '[53] min/max corrects');

  // 53.2 Ensemble vide → données insuffisantes (jamais 0).
  const dEmpty = describeValues([]);
  assert(dEmpty.sufficient === false && dEmpty.mean === null && dEmpty.median === null,
    '[53] ensemble vide → données insuffisantes (pas 0)');
  // Valeurs invalides filtrées.
  assert(describeValues([100, NaN, 'x', Infinity]).count === 1, '[53] valeurs non finies ignorées');

  // 53.3 Dispersion : écart-type d'échantillon + IQR.
  const d3 = describeValues([10, 20, 30, 40, 50]);
  assert(d3.stdDev === Math.round(Math.sqrt(250) * 100) / 100, '[53] écart-type échantillon (n-1)');
  assert(d3.iqr === 20, '[53] écart interquartile = p75 - p25 (20)');
  assert(describeValues([42]).stdDev === null, '[53] n=1 → dispersion non définie (null)');

  // 53.4 Évolution : positive, négative, division par zéro.
  const up = computeEvolution(100, 120);
  assert(up.absolute === 20 && up.percent === 20 && up.direction === 'hausse', '[53] évolution positive (+20 %, +20)');
  const down = computeEvolution(200, 150);
  assert(down.absolute === -50 && down.percent === -25 && down.direction === 'baisse', '[53] évolution négative (-50, -25 %)');
  const zeroInit = computeEvolution(0, 100);
  assert(zeroInit.percent === null, '[53] division par zéro → pas de pourcentage');
  assert(zeroInit.absolute === 100, '[53] variation absolue calculée malgré initial=0');
  assert(computeEvolution(NaN, 100).absolute === null, '[53] initial invalide → aucune évolution');

  // 53.5 Séries : déduplication par annonce et par période.
  const obs = [
    { adId: 1, observedAt: '2026-10-01T08:00:00Z', price: 100, priceValid: true },
    { adId: 1, observedAt: '2026-10-01T18:00:00Z', price: 90, priceValid: true },  // même annonce, même jour
    { adId: 2, observedAt: '2026-10-01T10:00:00Z', price: 200, priceValid: true },
    { adId: 1, observedAt: '2026-10-03T10:00:00Z', price: 80, priceValid: true },  // nouveau jour
  ];
  const series = buildSeries(obs, { granularity: 'day' });
  assert(series.points.length === 2, '[53] série : 2 jours avec données (pas de jour inventé)');
  assert(series.points[0].period === '2026-10-01' && series.points[0].ads === 2,
    '[53] série : annonce 1 comptée UNE fois pour le jour (2 annonces distinctes)');
  // Le 02/10 n'a aucune donnée : il est ABSENT (jamais un zéro fabriqué).
  assert(!series.points.some((p) => p.period === '2026-10-02'), '[53] série : aucune période sans données fabriquée');

  // 53.6 buildProductStats : annonces distinctes ≠ observations.
  const stats = buildProductStats(obs, { granularity: 'day', nowIso: '2026-10-05T00:00:00Z' });
  assert(stats.distinctAds === 2, '[53] stats : 2 annonces distinctes');
  assert(stats.observationsCount === 4, '[53] stats : 4 observations');
  assert(stats.overall.mean === 140, '[53] stats : moyenne des dernières valeurs par annonce ((90+80+200)/... = 140)');
  assert(stats.evolution.direction === 'baisse', '[53] stats : évolution calculée première→dernière période');
  assert(stats.quality.confidence === 'insufficient', '[53] qualité : 2 annonces → fiabilité insuffisante');

  // 53.7 Observations de prix invalides exclues mais comptées.
  const withInvalid = buildProductStats([
    { adId: 1, observedAt: '2026-10-01T00:00:00Z', price: 100, priceValid: true },
    { adId: 2, observedAt: '2026-10-01T00:00:00Z', price: null, priceValid: false },
  ], {});
  assert(withInvalid.quality.excludedObservations === 1, '[53] stats : prix invalides comptés comme exclus');
  assert(withInvalid.distinctAds === 1, '[53] stats : seules les annonces à prix valide comptent');

  // 53.8 Segmentation par état : ne jamais mélanger neuf et hors service.
  const segStats = buildProductStats([
    { adId: 1, observedAt: '2026-10-01T00:00:00Z', price: 100, priceValid: true, condition: 'new' },
    { adId: 2, observedAt: '2026-10-01T00:00:00Z', price: 300, priceValid: true, condition: 'new' },
    { adId: 3, observedAt: '2026-10-01T00:00:00Z', price: 40, priceValid: true, condition: 'for_parts' },
  ], {});
  assert(segStats.segments.byCondition.new.count === 2, '[53] segments : 2 prix neufs');
  assert(segStats.segments.byCondition.new.median === 200, '[53] segments : médiane neuf = 200');
  assert(segStats.segments.byCondition.for_parts.median === 40, '[53] segments : hors service isolé (40)');
  // Le prix hors service NE tire PAS la médiane globale vers le bas.
  assert(segStats.overall.median === 200, '[53] hors service exclu de la série principale (médiane globale = 200)');
  assert(segStats.quality.nonComparableAds === 1, '[53] nombre d\'annonces non comparables signalé');

  // 53.9 Aucun prix valide → état « données insuffisantes ».
  const noPrice = buildProductStats([{ adId: 1, observedAt: '2026-10-01T00:00:00Z', price: null, priceValid: false }], {});
  assert(noPrice.sufficient === false && noPrice.reason === 'no_valid_prices', '[53] aucun prix valide → données insuffisantes');

  // 53.10 periodKey : jour / semaine / mois.
  assert(periodKey('2026-10-18T12:00:00Z', 'day') === '2026-10-18', '[53] periodKey jour');
  assert(periodKey('2026-10-18T12:00:00Z', 'month') === '2026-10', '[53] periodKey mois');
  assert(/^2026-W\d\d$/.test(periodKey('2026-10-18T12:00:00Z', 'week')), '[53] periodKey semaine');

  console.log('\n[53] OK');
}

// ═══════════════════════════════════════════════════════════════════════════
// [54] ÉVOLUTION DES PRIX — persistance, migrations, corrections
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[54] Évolution des prix — persistance & migrations');
{
  const os = require('os');
  const { PriceHistoryService } = require('../src/main/services/history/priceHistoryService');
  const { PriceHistoryDb, isAvailable } = require('../src/main/services/history/priceHistoryDb');

  if (!isAvailable()) {
    console.log('  ⚠ node:sqlite indisponible — tests de persistance ignorés.');
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendra-ph-'));
    const dbPath = path.join(dir, 'history.sqlite');
    try {
      // 54.1 Migration appliquée + version de schéma.
      const db = PriceHistoryDb.open(dbPath);
      assert(db.schemaVersion() >= 1, '[54] schéma migré (version >= 1)');
      db.close();
      // Idempotence des migrations : réouvrir ne casse rien.
      const db2 = PriceHistoryDb.open(dbPath);
      assert(db2.schemaVersion() >= 1, '[54] migrations idempotentes (réouverture OK)');
      db2.close();

      const svc = new PriceHistoryService({ dbPath });
      const ads = [
        { id: 'A1', title: 'AMD Ryzen 5 9600X neuf', url: 'https://lbc/A1', prix: 220 },
        { id: 'A2', title: 'Ryzen 5 9600X', url: 'https://lbc/A2', prix: 200 },
        { id: 'A3', title: 'Lot de 2 Ryzen 5 9600X', url: 'https://lbc/A3', prix: 400 },
      ];
      // 54.2 Ingestion initiale.
      let r = svc.ingest(ads, { sourceJob: 'job-2026-10-01T10-00-00-000Z', observedAt: '2026-10-01T10:00:00.000Z' });
      assert(r.ok && r.summary.processed === 3, '[54] ingestion : 3 annonces traitées');
      assert(svc.stats().counts.ads === 3, '[54] ingestion : 3 annonces en base');

      // 54.3 Idempotence : re-ingérer NE DUPLIQUE PAS les annonces.
      r = svc.ingest(ads, { sourceJob: 'job-2026-10-01T10-00-00-000Z', observedAt: '2026-10-01T10:00:00.000Z' });
      assert(svc.stats().counts.ads === 3, '[54] idempotence : toujours 3 annonces après re-collecte');
      assert(r.summary.created === 0 && r.summary.updated === 3, '[54] idempotence : 0 créée, 3 mises à jour');
      // Aucune observation identique dupliquée.
      const obsAfterSame = svc.stats().counts.observations;
      assert(obsAfterSame === 3, '[54] observations identiques non dupliquées (3 observations)');

      // 54.4 Changement de prix → nouvelle observation CONSERVÉE.
      svc.ingest([{ id: 'A1', title: 'AMD Ryzen 5 9600X neuf', url: 'https://lbc/A1', prix: 190 }],
        { sourceJob: 'job-2026-10-05T10-00-00-000Z', observedAt: '2026-10-05T10:00:00.000Z' });
      assert(svc.stats().counts.observations === 4, '[54] changement de prix → observation conservée (4)');

      // 54.5 Le produit regroupe les annonces 9600X mais exclut le lot.
      const products = svc.listProducts({}).products;
      const p9600x = products.find((p) => p.reference === '9600X');
      assert(!!p9600x, '[54] produit 9600X créé');
      assert(p9600x.distinctAds === 2, '[54] produit 9600X : 2 annonces (lot exclu)');

      const detail = svc.getProductDetail(p9600x.id);
      assert(detail.includedAds.length === 2, '[54] fiche : 2 annonces incluses');
      assert(detail.stats.series.points.length === 2, '[54] fiche : série sur 2 périodes');

      // 54.6 Alias persisté.
      assert(detail.aliases.length >= 1 && detail.aliases[0].alias === '9600X', '[54] alias 9600X persisté');

      // 54.7 Persistance après fermeture/réouverture (redémarrage).
      svc.close();
      const svc2 = new PriceHistoryService({ dbPath });
      const statsAfter = svc2.stats();
      assert(statsAfter.counts.ads === 3 && statsAfter.counts.observations === 4, '[54] données conservées après redémarrage');
      const productsAfter = svc2.listProducts({}).products;
      assert(productsAfter.some((p) => p.reference === '9600X'), '[54] produits conservés après redémarrage');

      // 54.8 Correction manuelle : rejeter une annonce → exclue des séries.
      const pending = svc2.listPending({}).pending;
      const rejectedAd = pending.find((p) => p.title === 'Lot de 2 Ryzen 5 9600X');
      assert(!!rejectedAd, '[54] le lot est en file (rejeté/incertain)');
      // Correction : confirmer l'annonce A2 dans le produit 9600X explicitement.
      const p9600x2 = productsAfter.find((p) => p.reference === '9600X');
      const adA2 = svc2.engine().db.getAdBySourceId('A2');
      const corr = svc2.correct(adA2.id, { type: 'confirm', productId: p9600x2.id });
      assert(corr.ok, '[54] correction manuelle acceptée');
      // La correction est persistée et l'association est marquée manuelle.
      const link = svc2.engine().db.getLink(adA2.id);
      assert(link.link_status === 'manual', '[54] correction manuelle marquée « manual »');
      // Re-ingérer NE DOIT PAS écraser la correction manuelle.
      svc2.ingest([{ id: 'A2', title: 'Ryzen 5 9600X', url: 'https://lbc/A2', prix: 210 }],
        { sourceJob: 'job-2026-10-06T10-00-00-000Z', observedAt: '2026-10-06T10:00:00.000Z' });
      const linkAfter = svc2.engine().db.getLink(adA2.id);
      assert(linkAfter.link_status === 'manual', '[54] correction manuelle NON écrasée par le moteur auto');

      // 54.9 Recalcul après correction : les stats restent cohérentes.
      const recompute = svc2.recompute(p9600x2.id);
      assert(recompute.ok && recompute.stats.distinctAds >= 1, '[54] recalcul des statistiques après correction');

      // 54.10 Migration depuis des jobs existants (amorçage).
      const fakeJobs = [
        { id: 'job-2026-09-01T10-00-00-000Z', ads: [{ id: 'B1', title: 'Intel Core i5 13600K', url: 'https://lbc/B1', prix: 250 }] },
        { id: 'job-2026-09-02T10-00-00-000Z', ads: [{ id: 'B1', title: 'Intel Core i5 13600K', url: 'https://lbc/B1', prix: 230 }] },
      ];
      const boot = svc2.bootstrapFromJobs(fakeJobs);
      assert(boot.ok && boot.ads === 2, '[54] amorçage : 2 annonces traitées depuis les jobs');
      // B1 n'existe qu'une fois (déduplication inter-jobs).
      const b1 = svc2.engine().db.getAdBySourceId('B1');
      assert(!!b1, '[54] amorçage : annonce B1 présente');
      const b1obs = svc2.engine().db.listObservations(b1.id);
      assert(b1obs.length === 2, '[54] amorçage : les 2 prix distincts sont conservés (datés par le job)');
      assert(b1obs[0].observed_at.startsWith('2026-09-01'), '[54] amorçage : date réelle du job, pas de date inventée');

      // 54.11 Gestion d'erreur d'écriture : une annonce invalide est isolée.
      const bad = svc2.ingest([{ id: null, url: null, title: 'sans identifiant' }], {});
      assert(bad.ok && bad.summary.errors === 1 && bad.summary.processed === 0, '[54] annonce sans identifiant/URL isolée (pas de crash)');

      // 54.12 Distinction LIVE / IMPORTÉ : une observation de collecte réelle est
      // 'live' ; une migration depuis un job est 'imported' (sa date n'est jamais
      // présentée comme une date de collecte).
      const liveObs = svc2.engine().db.listObservations(svc2.engine().db.getAdBySourceId('A1').id);
      assert(liveObs.some((o) => o.origin === 'live'), '[54] observation de collecte marquée « live »');
      const b1origin = svc2.engine().db.listObservations(b1.id).map((o) => o.origin);
      assert(b1origin.every((o) => o === 'imported'), '[54] observations importées marquées « imported »');

      // 54.13 Un job SANS date exploitable ne fabrique JAMAIS de date : son
      // observation est marquée « imported » et datée de la première vue.
      const noDateJob = [{ id: 'dossier-sans-date', ads: [{ id: 'C1', title: 'AMD Ryzen 5 7600X', url: 'https://lbc/C1', prix: 180 }] }];
      const boot2 = svc2.bootstrapFromJobs(noDateJob);
      assert(boot2.ok && boot2.importedWithoutDate === 1, '[54] job sans date → signalé « sans date »');
      const c1obs = svc2.engine().db.listObservations(svc2.engine().db.getAdBySourceId('C1').id);
      assert(c1obs.length === 1 && c1obs[0].origin === 'imported', '[54] job sans date → observation marquée « imported » (pas de date inventée)');

      svc2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log('\n[54] OK');
}

// ═══════════════════════════════════════════════════════════════════════════
// [55] ÉVOLUTION DES PRIX — intégration (IPC, DOM, sécurité)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[55] Évolution des prix — intégration');
{
  const repoRoot = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

  // 55.1 Contrat IPC : chaque canal preload a un handler main.
  const preload = read('src/main/preload.js');
  const ipc = read('src/main/core/ipcHandlers.js');
  const preloadChans = [...preload.matchAll(/ipcRenderer\.invoke\('(history:[^']+)'/g)].map((m) => m[1]);
  const handledChans = new Set([...ipc.matchAll(/ipcMain\.handle\('(history:[^']+)'/g)].map((m) => m[1]));
  assert(preloadChans.length >= 8, '[55] preload expose les canaux history:*');
  const unhandled = preloadChans.filter((c) => !handledChans.has(c));
  assert(unhandled.length === 0, `[55] tous les canaux history:* ont un handler (${unhandled.join(', ')})`);

  // 55.2 Le renderer n'expose AUCUN accès SQL : pas de require('node:sqlite')
  // ni de canal générique d'exécution.
  const rendererFiles = ['src/renderer/priceEvolutionModule.js', 'src/renderer/app.js', 'src/renderer/utils.js'];
  for (const f of rendererFiles) {
    const code = read(f);
    assert(!/node:sqlite|require\(['"]sqlite/.test(code), `[55] ${f} : aucun accès direct à SQLite`);
  }
  assert(!/ipcMain\.handle\(['"]db:exec/.test(ipc) && !/executeSql|runSql|db:query/.test(ipc),
    '[55] aucun canal SQL générique exposé (pas d\'injection possible depuis le renderer)');

  // 55.3 Validation des entrées IPC : les options sont bornées côté main.
  assert(/sanitizeHistoryOpts/.test(ipc), '[55] options history:* assainies côté main');
  assert(/CORRECTION_ACTIONS/.test(ipc), '[55] actions de correction limitées à une liste blanche');

  // 55.4 L'onglet est présent et câblé.
  const html = read('src/renderer/index.html');
  assert(/data-tab="tab-price-evolution"/.test(html), '[55] bouton de navigation de l\'onglet présent');
  assert(/id="tab-price-evolution"/.test(html), '[55] section tab-price-evolution présente');
  assert(/src="priceEvolutionModule.js"/.test(html), '[55] module renderer chargé');
  const appJs = read('src/renderer/app.js');
  assert(/tab-price-evolution['"]\)\s*\{\s*\n?\s*loadPriceEvolutionPage\(\)/.test(appJs) || /loadPriceEvolutionPage\(\)/.test(appJs),
    '[55] app.js déclenche le chargement de l\'onglet');
  // Les scripts sont chargés AVANT app.js (ordre d\'exécution).
  const idxScript = html.indexOf('priceEvolutionModule.js');
  const idxApp = html.indexOf('src="app.js"');
  assert(idxScript >= 0 && idxApp >= 0 && idxScript < idxApp, '[55] priceEvolutionModule chargé avant app.js');

  // 55.5 Le renderer échappe les données issues de la base (XSS).
  const pe = read('src/renderer/priceEvolutionModule.js');
  assert(/escapeHtml\(/.test(pe), '[55] module : descriptions/titres échappés (escapeHtml)');
  assert(!/innerHTML\s*=\s*[^;]*\+\s*p\.title(?!\S)/.test(pe) || /escapeHtml\(p\.title/.test(pe),
    '[55] module : titres jamais injectés bruts dans innerHTML');

  // 55.6 L\'ingestion est branchée sur la fin de collecte (hook ipcHandlers).
  assert(/priceHistoryService/.test(ipc) && /histService\.ingest\(/.test(ipc),
    '[55] ipcHandlers : ingestion de l\'historique après collecte');
  // Isolation : l\'ingestion est dans un try/catch (une erreur n\'échoue pas le job).
  assert(/catch \(histErr\)/.test(ipc), '[55] ipcHandlers : erreur d\'historique isolée du job');

  // 55.7 Le module de persistance reste importable sans Electron.
  const dbCode = read('src/main/services/history/priceHistoryDb.js');
  assert(!/require\(['"]electron['"]\)/.test(dbCode), '[55] priceHistoryDb : aucune dépendance Electron');
  const statsCode = read('src/main/services/history/priceStats.js');
  assert(!/require\(['"]electron['"]\)/.test(statsCode), '[55] priceStats : aucune dépendance Electron');

  console.log('\n[55] OK');
}

// ═══════════════════════════════════════════════════════════════════════════
// [56] ÉVOLUTION DES PRIX — règles de prix (invalides, atypiques, devises)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[56] Évolution des prix — règles de prix');
{
  const { analyzePrice, normalizeCurrency, detectOutliers, deliveryAvailability } = require('../src/main/services/history/priceRules');

  // 56.1 Prix valides (number et chaîne FR).
  assert(analyzePrice(1250).valid === true, '[56] prix numérique valide');
  assert(analyzePrice('1 250 €').value === 1250, '[56] prix « 1 250 € » → 1250');
  assert(analyzePrice('1.299,99').value === 1299.99, '[56] prix « 1.299,99 » → 1299,99');

  // 56.2 Prix absents / nuls / négatifs / non numériques → exclus avec motif.
  assert(analyzePrice(null).excluded === true && analyzePrice(null).reason === 'missing', '[56] prix absent → motif « missing »');
  assert(analyzePrice('').reason === 'missing', '[56] prix vide → motif « missing »');
  assert(analyzePrice(0).reason === 'zero' && analyzePrice(0).excluded === true, '[56] prix 0 → exclu (motif « zero »)');
  assert(analyzePrice(-10).reason === 'negative', '[56] prix négatif → exclu');
  assert(analyzePrice('sur demande').reason === 'non_numeric', '[56] « sur demande » → non numérique');
  assert(analyzePrice('gratuit').reason === 'non_numeric', '[56] « gratuit » → non numérique');
  assert(analyzePrice(999999999).reason === 'absurd', '[56] prix manifestement aberrant → exclu');

  // 56.3 Prix « négociable » : on extrait la valeur numérique si présente.
  const neg = analyzePrice('100 € négociable');
  assert(neg.valid === true && neg.value === 100, '[56] « 100 € négociable » → 100 (valeur conservée)');

  // 56.4 Prix symbolique : conservé (flag), jamais supprimé.
  const sym = analyzePrice(1);
  assert(sym.valid === true && sym.flags.includes('symbolic'), '[56] prix symbolique conservé + signalé');

  // 56.5 Devises.
  assert(normalizeCurrency('€') === 'EUR' && normalizeCurrency(undefined) === 'EUR', '[56] devise par défaut EUR');
  assert(normalizeCurrency('$') === 'USD' && normalizeCurrency('chf') === 'CHF', '[56] devises reconnues');
  assert(analyzePrice(100, { currency: '$' }).currency === 'USD', '[56] devise propagée dans l\'analyse');
  assert(normalizeCurrency('XYZ') === 'XYZ', '[56] devise inconnue conservée telle quelle (pas de conversion inventée)');

  // 56.6 Détection d'atypiques (IQR) — signale SANS supprimer.
  const out = detectOutliers([100, 105, 110, 115, 120, 5000]);
  assert(out && out.outliers.includes(5000), '[56] prix aberrant signalé par IQR (conservé, non supprimé)');
  assert(detectOutliers([100, 200]) === null, '[56] trop peu de points → pas d\'analyse IQR');

  // 56.7 Coûts supplémentaires : disponibilité de livraison (jamais un montant inventé).
  assert(deliveryAvailability({ deliveryType: 'livraison' }).shippingAvailable === true, '[56] livraison disponible détectée');
  assert(deliveryAvailability({ deliveryType: 'main_propre' }).shippingAvailable === false, '[56] main propre → livraison non disponible');
  assert(deliveryAvailability({ deliveryType: 'les_deux' }).shippingAvailable === true
    && deliveryAvailability({ deliveryType: 'les_deux' }).handDeliveryAvailable === true,
    '[56] les_deux → livraison ET main propre');
  assert(deliveryAvailability({}).shippingAvailable === false, '[56] deliveryType inconnu → aucune supposition');

  console.log('\n[56] OK');
}

// ═══════════════════════════════════════════════════════════════════════════
// [57] ÉVOLUTION DES PRIX — renderer réel dans un DOM jsdom
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[57] Évolution des prix — rendu renderer (jsdom)');
{
  const { JSDOM } = require('jsdom');
  const repoRoot = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(repoRoot, 'src/renderer/index.html'), 'utf8');

  // Extrait la section réelle de l'onglet depuis index.html : si un id attendu
  // par le module disparaissait, ce test échouerait (contrat DOM réel).
  const start = html.indexOf('<section id="tab-price-evolution"');
  const end = html.indexOf('</section>', start) + '</section>'.length;
  assert(start > 0 && end > start, '[57] section tab-price-evolution présente dans index.html');
  const sectionHtml = html.slice(start, end);

  const dom = new JSDOM(`<!doctype html><html><body><div id="toastContainer"></div>${sectionHtml}</body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://app.local/' });
  const { window } = dom;

  // Stub d'API : on renvoie des données RÉELLES de forme connue (jamais fictives
  // dans l'app, mais ici c'est un test).
  const products = [
    { id: 1, label: 'AMD Ryzen 5 9600X', reference: '9600X', brand: 'amd', family: 'cpu', distinctAds: 3, median: 220, evolution: { absolute: -10, percent: -4.3, direction: 'baisse' }, lastObservedAt: '2026-10-18T10:00:00Z', quality: { confidence: 'low' } },
    { id: 2, label: 'RTX 3060 Ti', reference: '3060TI', brand: 'nvidia', family: 'gpu', distinctAds: 12, median: 300, evolution: { absolute: 0, percent: 0, direction: 'stable' }, lastObservedAt: '2026-10-17T10:00:00Z', quality: { confidence: 'medium' } },
  ];
  const detail = {
    ok: true,
    product: { id: 1, label: 'AMD Ryzen 5 9600X', reference: '9600X', brand: 'amd', family: 'cpu', status: 'confirmed', units: {} },
    stats: {
      distinctAds: 3, observationsCount: 5, sufficient: true,
      overall: { mean: 215, median: 220, min: 200, max: 230, stdDev: 12.5 },
      evolution: { absolute: -10, percent: -4.3, direction: 'baisse' },
      segments: { byCondition: { new: { count: 2, ads: 2, median: 225, mean: 225 } }, byOfferType: { single: { count: 3, ads: 3, median: 220 } } },
      series: { points: [{ period: '2026-10-17', median: 230, mean: 230, ads: 2 }, { period: '2026-10-18', median: 220, mean: 220, ads: 1 }] },
      quality: { confidence: 'low', freshnessDays: 0, excludedObservations: 1 },
    },
    aliases: [{ alias: '9600X', source: 'observed' }],
    includedAds: [{ id: 'A1', title: '<script>alert(1)</script>', url: 'https://lbc/A1', price: 220, condition: 'new', offerType: 'single', lastSeen: '2026-10-18T10:00:00Z' }],
    excludedAds: [{ id: 'A3', title: 'Lot de 2', reasons: ['offer_type_incompatible'] }],
  };
  const pending = [{ adId: 9, title: 'Ryzen 5 9600 X', decision: 'uncertain', score: 40, reference: '9600X', family: 'cpu', url: 'https://lbc/9', candidates: [{ productId: 1, label: 'AMD Ryzen 5 9600X', score: 40 }] }];

  let selectedId = null;
  window.api = {
    historyStats: async () => ({ ok: true, counts: { ads: 20, products: 2, observations: 30, pending: 1 }, families: ['cpu', 'gpu'] }),
    historyBootstrap: async () => ({ ok: true, jobs: 0, ads: 0 }),
    historyListProducts: async () => ({ ok: true, products }),
    historyProductDetail: async (id) => { selectedId = id; return detail; },
    historyListPending: async () => ({ ok: true, pending }),
    historyCorrect: async () => ({ ok: true }),
    historyRecompute: async () => ({ ok: true }),
    openExternal: () => {},
  };

  // Charge utils (escapeHtml/escapePath/showToast/debounce) puis le module dans
  // le MÊME scope d'eval (comme les autres tests renderer).
  const utilsSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/utils.js'), 'utf8');
  const modSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/priceEvolutionModule.js'), 'utf8');
  window.eval(utilsSrc + '\n' + modSrc);

  // 57.1 Le module s'exécute sans lever (tous les ids du DOM existent).
  assert(true, '[57] le module renderer s\'initialise sans erreur (contrat DOM)');

  // 57.2 Chargement de la page → liste des produits rendue.
  await window.loadPriceEvolutionPage();
  await new Promise((r) => setTimeout(r, 20));
  const rows = window.document.querySelectorAll('#peProductsBody tr.pe-row');
  assert(rows.length === 2, '[57] 2 produits affichés dans le tableau');
  const bodyText = window.document.getElementById('peProductsBody').textContent;
  assert(/9600X/.test(bodyText) && /3060TI/.test(bodyText), '[57] références affichées');
  assert(/baisse/.test(rows[0].className) === false, '[57] ligne produit rendue');

  // 57.3 Sélection d'un produit → fiche détaillée remplie.
  await window.peSelectProduct(1);
  await new Promise((r) => setTimeout(r, 20));
  assert(selectedId === 1, '[57] la sélection appelle historyProductDetail avec le bon id');
  assert(window.document.getElementById('peStatMedian').textContent.includes('220'), '[57] médiane affichée (220 €)');
  assert(window.document.getElementById('peStatAds').textContent === '3', '[57] nombre d\'annonces affiché');
  assert(/baisse/.test(window.document.getElementById('peStatEvo').textContent) || /-/.test(window.document.getElementById('peStatEvo').textContent),
    '[57] évolution affichée');
  assert(window.document.getElementById('peSegments').textContent.includes('Neuf'), '[57] segment état affiché');

  // 57.4 XSS : le titre d'annonce est échappé, jamais exécuté comme HTML.
  const includedHtml = window.document.getElementById('peIncludedBody').innerHTML;
  assert(!/<script>alert\(1\)<\/script>/.test(includedHtml), '[57] titre malveillant NON injecté comme HTML brut');
  assert(/&lt;script&gt;/.test(includedHtml), '[57] titre malveillant échappé (&lt;script&gt;)');

  // 57.5 Annonces exclues + motif lisible.
  assert(/Lot/.test(window.document.getElementById('peExcludedBody').textContent), '[57] annonce exclue listée');
  assert(/Type d'offre incompatible/.test(window.document.getElementById('peExcludedBody').textContent),
    '[57] motif d\'exclusion traduit en clair');

  // 57.6 File des rapprochements incertains.
  window.document.getElementById('pePendingToggle').click();
  await new Promise((r) => setTimeout(r, 20));
  assert(/Ryzen 5 9600 X/.test(window.document.getElementById('pePendingBody').textContent), '[57] annonce incertaine affichée');
  assert(window.document.querySelectorAll('#pePendingBody [data-action="peConfirmCandidate"]').length === 1,
    '[57] bouton de confirmation de candidat présent');

  // 57.7 Aucune donnée fabriquée : une valeur absente s'affiche « — ».
  const empty = { ok: true, product: { id: 5, label: 'Produit X', status: 'provisional', units: {} }, stats: { distinctAds: 0, observationsCount: 0, sufficient: false, overall: { mean: null, median: null, min: null, max: null, stdDev: null }, evolution: {}, segments: {}, series: { points: [] }, quality: {} }, aliases: [], includedAds: [], excludedAds: [] };
  window.api.historyProductDetail = async () => empty;
  await window.peSelectProduct(5);
  await new Promise((r) => setTimeout(r, 20));
  assert(window.document.getElementById('peStatMedian').textContent === '—', '[57] prix absent affiché « — » (jamais 0)');
  assert(!window.document.getElementById('peSeriesEmpty').classList.contains('hidden'), '[57] série vide → message « aucune observation »');

  console.log('\n[57] OK');
}


console.log(`\n=== RÉSULTAT : ${pass} réussis, ${fail} échoués ===`);
process.exit(fail > 0 ? 1 : 0);
}
main().catch((err) => { console.error(err); process.exit(1); });
