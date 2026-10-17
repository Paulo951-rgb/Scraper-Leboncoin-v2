'use strict';

console.log('--- DÉMARRAGE ELECTRON ---');

process.on('uncaughtException', (err) => {
  console.error('❌ ERREUR DANS MAIN PROCESS :', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ PROMESSE REJETÉE DANS MAIN PROCESS :', reason);
});

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');

// In a packaged app, Playwright's Chromium binary lives in extraResources/browsers/.
// Point PLAYWRIGHT_BROWSERS_PATH there so Playwright finds it at runtime.
if (process.env.NODE_ENV === 'production' || app.isPackaged) {
  const browsersPath = path.join(process.resourcesPath, 'browsers');
  if (fs.existsSync(browsersPath)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  } else {
    console.error(`⚠️ Dossier des navigateurs Playwright introuvable : ${browsersPath} — le scraping échouera.`);
  }
}

/**
 * Vérifie que le Chromium embarqué (Chrome for Testing) est présent et
 * exécutable, et renvoie un diagnostic clair en cas d'absence. Empêche le
 * message cryptique « Executable doesn't exist » au premier chromium.launch().
 * @returns {{ok:boolean, path?:string, error?:string}}
 */
function checkEmbeddedChromium() {
  try {
    const { chromium } = require('playwright');
    const exe = chromium.executablePath();
    if (exe && fs.existsSync(exe)) return { ok: true, path: exe };
    return {
      ok: false,
      error: `Chromium Playwright introuvable (chemin attendu : ${exe || 'inconnu'}). `
        + `PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH || '(non défini)'}.`,
    };
  } catch (err) {
    return { ok: false, error: `Impossible de localiser Playwright/Chromium : ${err.message}` };
  }
}

const { logger } = require('./utils/logger');
logger.info('--- DÉMARRAGE ELECTRON ---');

let setupIpcHandlers;
try {
  ({ setupIpcHandlers } = require('./core/ipcHandlers'));
  console.log('✅ ipcHandlers chargé avec succès.');
} catch (err) {
  console.error('❌ Erreur de chargement de ipcHandlers :', err);
}

let mainWindow;
let widgetWindow = null;

// Getter de la fenêtre principale (pour ipcHandlers) : renvoie null si fermée.
function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function createWidgetWindow() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.focus();
    return;
  }

  widgetWindow = new BrowserWindow({
    width: 220,
    height: 160,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: false,
    title: 'Widget Scraper',
    webPreferences: {
      preload: path.join(__dirname, 'widgetPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  widgetWindow.loadFile(path.join(__dirname, '../renderer/widget.html'));

  // Le widget est une page locale figée : aucune navigation ni fenêtre externe.
  widgetWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  widgetWindow.on('closed', () => {
    widgetWindow = null;
  });
}

// IPC pour le widget flottant
ipcMain.on('widget:toggle', () => {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.close();
  } else {
    createWidgetWindow();
  }
});

ipcMain.on('widget:close', () => {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.close();
  }
});

// Envoie les mises à jour de progression/statut au widget flottant
function sendToWidget(channel, data) {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send(channel, data);
  }
}

ipcMain.on('widget:progress', (event, data) => sendToWidget('widget:progress', data));
ipcMain.on('widget:status', (event, data) => sendToWidget('widget:status', data));

function createWindow() {
  console.log('Création de la fenêtre Electron...');

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 650,
    title: 'Leboncoin Scraper Pro',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // webviewTag désactivé : aucun <webview> n'est utilisé par l'UI (l'ancien
      // module IA Studio, seul consommateur, a été retiré). Laisser ce tag actif
      // augmentait inutilement la surface d'attaque (création de webview depuis
      // le renderer). Le handler will-attach-webview reste en défense en
      // profondeur au cas où il serait réactivé.
      webviewTag: false,
    },
  });

  const indexPath = path.join(__dirname, '../renderer/index.html');
  console.log('Chargement du fichier HTML :', indexPath);

  mainWindow.loadFile(indexPath).catch((err) => {
    console.error('❌ Impossible de charger index.html :', err);
  });

  // Durcissement navigation : l'UI est une page locale unique. Toute tentative
  // d'ouverture de fenêtre (window.open / target=_blank) ou de navigation vers
  // une autre origine est refusée. Les liens externes passent exclusivement par
  // shell:openExternal (validé http/https). Sans cela, un lien injecté (ex: dans
  // une description d'annonce) pourrait charger une page distante dans la fenêtre
  // privilégiée (nodeIntegration=false, mais accès à window.api).
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    const allowed = path.join(__dirname, '../renderer/index.html');
    if (navigationUrl.split('#')[0] !== `file://${allowed}`) {
      event.preventDefault();
      console.warn(`[security] Navigation bloquée : ${navigationUrl}`);
    }
  });

  // Refus par défaut de TOUTES les permissions navigateur (géolocalisation,
  // caméra, micro, notifications, presse-papiers en lecture, etc.). L'UI n'en
  // a besoin d'aucune : le scraped content est affiché, jamais exécuté, et les
  // éventuels accès passent par le main process. Sans handler explicite,
  // Electron accorde certaines permissions par défaut.
  const denyPermission = () => false;
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  mainWindow.webContents.session.setPermissionCheckHandler(denyPermission);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Mode sonde E2E (uniquement avec --e2e-probe) : après chargement, exécute une
  // sonde DOM dans le renderer réel et écrit le rapport JSON sur stdout, puis
  // quitte. N'est JAMAIS actif en usage normal (le flag n'est pas passé par
  // l'installeur). Permet des tests E2E réels sans dépendance à un driver
  // externe.
  if (process.argv.includes('--e2e-probe')) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const probe = await mainWindow.webContents.executeJavaScript(E2E_PROBE_SCRIPT);
        console.log(`[E2E_PROBE] ${JSON.stringify(probe)}`);
      } catch (err) {
        console.log(`[E2E_PROBE] ${JSON.stringify({ error: String(err && err.message || err) })}`);
      } finally {
        setTimeout(() => app.exit(0), 200);
      }
    });
  }
}

/**
 * Sonde DOM exécutée dans le renderer pour les tests E2E. Renvoie un objet
 * factuel sur l'état de l'UI : titre, onglets, pont preload, modales, contrôles
 * de vitesse (doivent être absents). Isolée ici pour rester proche du mode
 * --e2e-probe qui l'utilise.
 */
const E2E_PROBE_SCRIPT = `(async () => {
  const out = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    out.title = document.title || '';
    // Laisse le temps au premier-lancement (écran légal, init modules) de se faire.
    await sleep(900);
    // Écran d'information légale (1er lancement) : doit s'afficher puis être
    // refermable — on le teste explicitement avant de poursuivre.
    const legal = document.getElementById('legalNoticeModal');
    out.legalShown = !!legal && !legal.classList.contains('hidden');
    const legalAccept = document.getElementById('legalNoticeAcceptBtn');
    if (legalAccept) { legalAccept.click(); await sleep(50); }
    out.legalDismissed = !!legal && legal.classList.contains('hidden');

    const navs = Array.from(document.querySelectorAll('[data-tab]'));
    out.navCount = navs.length;
    out.hasApi = typeof window.api === 'object' && window.api !== null;
    out.apiKeys = out.hasApi ? Object.keys(window.api) : [];
    out.nodeIntegration = typeof require !== 'undefined' || typeof process !== 'undefined';
    out.contextIsolated = typeof window.api === 'object';
    // Contrôles de vitesse/délai qui ne doivent PLUS exister.
    out.speedControls = document.querySelectorAll('#cfgScrapeSpeed, #cfgPageDelay, [data-speed], select[name="speed"]').length;
    out.readonlyPolicy = !!document.querySelector('.scraping-mode-readonly, [data-scraping-policy], .scraping-config');
    // Active chaque onglet et vérifie qu'il devient visible.
    let switched = 0;
    for (const nav of navs) {
      nav.click();
      await sleep(20);
      const tabId = nav.getAttribute('data-tab');
      const panel = document.getElementById(tabId);
      if (panel) {
        const style = window.getComputedStyle(panel);
        if (style.display !== 'none' && style.visibility !== 'hidden') switched++;
      }
    }
    out.tabsSwitched = switched;
    const isVisible = (el) => !!el && !el.classList.contains('hidden') && window.getComputedStyle(el).display !== 'none';
    // FAQ
    const faqBtn = document.getElementById('openFaqBtn');
    if (faqBtn) {
      faqBtn.click(); await sleep(50);
      out.faqOpened = isVisible(document.getElementById('faqModal'));
      out.faqItems = document.querySelectorAll('#faqModal .faq-item, #faqAccordion .faq-item').length;
      document.getElementById('faqModal')?.classList.add('hidden');
    }
    // Paramètres
    const setBtn = document.getElementById('openSettingsModalBtn');
    if (setBtn) {
      setBtn.click(); await sleep(50);
      out.settingsOpened = isVisible(document.getElementById('settingsModal'));
      document.getElementById('settingsModal')?.classList.add('hidden');
    }
    out.bodyText = (document.body.innerText || '').slice(0, 4000);
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  return out;
})()`;

// Single-instance lock : empêche plusieurs instances concurrentes (qui se
// battraient pour la session globale et les fichiers de job).
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  console.log('Une autre instance est déjà en cours — fermeture.');
  app.quit();
} else {
  app.on('second-instance', () => {
    // L'utilisateur a relancé l'app : focus sur la fenêtre existante.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  console.log('✅ Electron app ready !');
  // Préflight Chromium : si le navigateur embarqué manque (installeur tronqué,
  // antivirus, extraction incomplète), on le signale immédiatement au lieu de
  // laisser échouer le premier scraping avec « Executable doesn't exist ».
  const chromiumCheck = checkEmbeddedChromium();
  if (!chromiumCheck.ok) {
    console.error(`❌ Préflight Chromium : ${chromiumCheck.error}`);
    logger.error(`Préflight Chromium échoué : ${chromiumCheck.error}`);
  } else {
    logger.info(`Préflight Chromium OK : ${chromiumCheck.path}`);
  }
  // Enregistre les handlers IPC UNE SEULE FOIS (évite "second handler" au
  // recréation de fenêtre). Le getter permet de toujours cibler la fenêtre
  // courante même après recréation.
  if (setupIpcHandlers) {
    const { shutdown } = setupIpcHandlers(getMainWindow);
    // Arrêt propre des jobs en cours à la fermeture (sinon le pipeline forké
    // et son Chromium continuaient en arrière-plan, orphelins du main).
    app.on('before-quit', () => {
      try { shutdown(); } catch { /* best-effort */ }
    });
  }
  createWindow();
}).catch((err) => {
  console.error('❌ Erreur app.whenReady :', err);
});

app.on('window-all-closed', () => {
  console.log('Toutes les fenêtres sont fermées.');
  if (process.platform !== 'darwin') app.quit();
});

// macOS : recrée une fenêtre quand on clique sur l'icône du dock et qu'aucune
// fenêtre n'est ouverte (comportement attendu sur Mac).
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Défense en profondeur pour les <webview>. webviewTag est DÉSACTIVÉ sur la
// fenêtre principale (aucun <webview> n'est utilisé), mais ce handler reste en
// place : s'il était un jour réactivé, un renderer compromis ne pourrait pas
// créer un <webview> avec nodeIntegration:true contournant le sandboxing. On
// force donc les webpreferences sûres sur TOUT webview attaché.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (_e, webPreferences, params) => {
    // Tout preload non autorisé est supprimé (sécurité : un renderer
    // compromis ne peut pas injecter son propre preload).
    delete webPreferences.preload;
    webPreferences.contextIsolation = true;
    // Verrouille systématiquement : pas de Node.js dans le webview.
    webPreferences.nodeIntegration = false;
    webPreferences.webSecurity = true;
    webPreferences.sandbox = true;
    // Isole chaque webview dans sa propre session (pas d'accès
    // au cache/cookies app).
    if (!params.partition || params.partition === 'persist:default') {
      webPreferences.partition = 'webview-sandbox';
    }
  });
});