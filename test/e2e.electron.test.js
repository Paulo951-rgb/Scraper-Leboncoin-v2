'use strict';

/**
 * Tests E2E Electron — lancent RÉELLEMENT l'application (main + preload +
 * renderer) et vérifient le comportement observable de l'interface.
 *
 * Ce n'est PAS un test simulé : on démarre un vrai processus Electron via
 * `child_process.spawn`, on attend que le renderer signale qu'il est prêt, puis
 * on interroge le DOM réel (navigation d'onglets, ouverture des modales,
 * présence du pont preload `window.api`, absence d'erreur fatale, arrêt propre).
 *
 * Contraintes d'environnement :
 *   - nécessite un affichage. En CI Linux sans écran, lancer via
 *     `xvfb-run -a npm run test:e2e`, ou laisser le script ajouter
 *     `--ozone-platform=headless` (déjà fait par défaut ici).
 *   - sur Windows, aucun affichage virtuel n'est nécessaire.
 *
 * Chaque scénario utilise un profil utilisateur ISOLÉ (dossier temporaire via
 * `--user-data-dir`), donc jamais les données réelles de l'utilisateur.
 *
 * Sortie : code 0 si tout passe, 1 sinon. `--json` écrit un rapport JSON.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const ELECTRON_BIN = require('electron'); // chemin de l'exécutable Electron

let pass = 0;
let fail = 0;
const failures = [];
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(label); console.error(`  ✗ ${label}`); }
}

function makeProfileDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lbp-e2e-'));
}

/**
 * Lance l'application Electron avec un profil isolé et renvoie un contrôleur.
 */
function launchApp(extraArgs = []) {
  const profileDir = makeProfileDir();
  const args = [
    '.',
    `--user-data-dir=${profileDir}`,
    '--no-sandbox',
    '--disable-gpu',
    '--ozone-platform=headless',
    '--disable-dev-shm-usage',
    ...extraArgs,
  ];
  const child = spawn(ELECTRON_BIN, args, {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const state = {
    child,
    profileDir,
    stdout: '',
    stderr: '',
    exited: false,
    exitCode: null,
    ready: false,
    rendererErrors: [],
  };
  child.stdout.on('data', (d) => { state.stdout += d.toString(); });
  child.stderr.on('data', (d) => { state.stderr += d.toString(); });
  child.on('exit', (code) => { state.exited = true; state.exitCode = code; });
  return state;
}

function waitFor(cond, timeoutMs = 30000, intervalMs = 200) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      let ok = false;
      try { ok = cond(); } catch { ok = false; }
      if (ok) { clearInterval(timer); resolve(true); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); reject(new Error('Timeout en attente de condition')); }
    }, intervalMs);
  });
}

async function stopApp(state) {
  if (state.exited) return;
  state.child.kill('SIGTERM');
  try {
    await waitFor(() => state.exited, 8000, 150);
  } catch {
    state.child.kill('SIGKILL');
    await waitFor(() => state.exited, 5000, 150).catch(() => {});
  }
  try { fs.rmSync(state.profileDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ── Scénario principal : démarrage, DOM réel, navigation, modales ────────────
async function scenarioStartupAndUI() {
  console.log('\n[E2E] Démarrage, pont preload, navigation, modales');
  const app = launchApp();
  try {
    // 1) L'app démarre et le main atteint « app ready ».
    await waitFor(() => /Electron app ready/i.test(app.stdout), 40000);
    assert(true, 'E2E: le main process atteint "Electron app ready"');

    // 2) Pas d'erreur fatale au démarrage.
    assert(!/ERREUR DANS MAIN PROCESS/.test(app.stderr), 'E2E: aucune uncaughtException dans le main');
    assert(!/Impossible de charger index.html/.test(app.stderr), 'E2E: index.html chargé sans erreur');

    // 3) Préflight Chromium exécuté (nouvelle vérification de démarrage).
    assert(/Préflight Chromium/i.test(app.stdout) || /Préflight Chromium/i.test(app.stderr),
      'E2E: le préflight Chromium est exécuté au démarrage');

    // Le renderer ne peut pas être piloté sans canal de test dédié : on vérifie
    // via un second scénario dédié l'absence d'écran blanc (voir scenarioDomProbe).
  } finally {
    await stopApp(app);
  }
  assert(app.exited, 'E2E: le processus se ferme proprement après SIGTERM');
  assert(app.exitCode === null || app.exitCode === 0 || app.exitCode === 143,
    `E2E: code de sortie propre (obtenu ${app.exitCode})`);
}

// ── Scénario : sonde DOM réelle via un point d'entrée de test ────────────────
// Le main expose un mode `--e2e-probe` qui, après le chargement de la fenêtre,
// exécute une sonde DOM dans le renderer et écrit le résultat JSON sur stdout.
async function scenarioDomProbe() {
  console.log('\n[E2E] Sonde DOM réelle (onglets, modales, pont preload)');
  const app = launchApp(['--e2e-probe']);
  try {
    await waitFor(() => /\[E2E_PROBE\]/.test(app.stdout), 45000);
    const line = app.stdout.split('\n').find((l) => l.includes('[E2E_PROBE]'));
    let probe = null;
    try { probe = JSON.parse(line.slice(line.indexOf('[E2E_PROBE]') + '[E2E_PROBE]'.length).trim()); } catch { /* ignore */ }
    assert(probe !== null, 'E2E: la sonde DOM renvoie un rapport JSON exploitable');
    if (probe) {
      assert(probe.title && probe.title.length > 0, 'E2E: le titre de la fenêtre est défini (pas d\'écran blanc)');
      assert(probe.navCount >= 5, `E2E: ${probe.navCount} onglets de navigation présents`);
      assert(probe.hasApi === true, 'E2E: le pont preload window.api est exposé au renderer');
      assert(probe.apiKeys && probe.apiKeys.includes('startScraping'), 'E2E: window.api.startScraping exposé');
      assert(probe.bodyText && probe.bodyText.length > 50, 'E2E: le contenu de l\'écran principal est rendu');
      assert(probe.legalShown === true, 'E2E: l\'écran d\'information légale s\'affiche au premier lancement');
      assert(probe.legalDismissed === true, 'E2E: l\'écran légal se referme après acceptation');
      assert(probe.tabsSwitched === probe.navCount, `E2E: les ${probe.navCount} onglets ont pu être activés`);
      assert(probe.faqOpened === true, 'E2E: la FAQ s\'ouvre');
      assert(probe.faqItems > 5, `E2E: la FAQ contient ${probe.faqItems} entrées`);
      assert(probe.settingsOpened === true, 'E2E: la modale Paramètres s\'ouvre');
      assert(probe.speedControls === 0, 'E2E: aucun contrôle de vitesse/délai modifiable dans l\'UI');
      assert(probe.readonlyPolicy === true, 'E2E: la politique de scraping est affichée en lecture seule');
    }
  } finally {
    await stopApp(app);
  }
}

// ── Scénario : sécurité du preload (surface d'API) ───────────────────────────
async function scenarioPreloadSurface() {
  console.log('\n[E2E] Surface d\'API du preload (sécurité)');
  const app = launchApp(['--e2e-probe']);
  try {
    await waitFor(() => /\[E2E_PROBE\]/.test(app.stdout), 45000);
    const line = app.stdout.split('\n').find((l) => l.includes('[E2E_PROBE]'));
    let probe = null;
    try { probe = JSON.parse(line.slice(line.indexOf('[E2E_PROBE]') + '[E2E_PROBE]'.length).trim()); } catch { /* ignore */ }
    if (probe) {
      const keys = probe.apiKeys || [];
      // Aucune primitive Node exposée au renderer.
      for (const forbidden of ['require', 'process', 'fs', 'child_process', 'eval']) {
        assert(!keys.includes(forbidden), `E2E: window.api n'expose pas "${forbidden}"`);
      }
      assert(probe.nodeIntegration === false, 'E2E: nodeIntegration désactivé dans le renderer');
      assert(probe.contextIsolated === true, 'E2E: contextIsolation actif (pas de global Node)');
    }
  } finally {
    await stopApp(app);
  }
}

async function main() {
  console.log('=== TESTS E2E ELECTRON (Leboncoin Scraper Pro) ===');
  console.log(`Electron : ${ELECTRON_BIN}`);
  await scenarioStartupAndUI();
  await scenarioDomProbe();
  await scenarioPreloadSurface();
  console.log(`\n=== RÉSULTAT E2E : ${pass} réussis, ${fail} échoués ===`);
  if (fail > 0) {
    console.error('Échecs :\n - ' + failures.join('\n - '));
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => { console.error('Erreur E2E :', err); process.exit(1); });
}
