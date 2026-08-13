'use strict';

console.log('--- DÉMARRAGE ELECTRON ---');

process.on('uncaughtException', (err) => {
  console.error('❌ ERREUR DANS MAIN PROCESS :', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ PROMESSE REJETÉE DANS MAIN PROCESS :', reason);
});

const path = require('path');
const { app, BrowserWindow, ipcMain, session } = require('electron');

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

// Partition persistante partagée entre le <webview> de l'onglet IA Studio et
// la fenêtre de connexion Google dédiée. Une fois connecté dans la fenêtre,
// la session/cookies sont partagés avec le webview.
const AI_STUDIO_PARTITION = 'persist:aistudio';

// User-Agent Chrome réel (sans le mot "Electron") — Google bloque les
// navigateurs qui s'identifient comme Electron pour la connexion OAuth.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Configure la partition IA Studio : UA Chrome + interception des en-têtes
// Client Hints (sec-ch-ua) pour retirer la marque "Electron" que Google
// détecte même avec un UA spoofé. À appeler une fois, avant la création du
// webview/de la fenêtre de connexion.
let aiStudioSessionConfigured = false;
function configureAiStudioSession() {
  if (aiStudioSessionConfigured) return;
  try {
    const ses = session.fromPartition(AI_STUDIO_PARTITION);
    ses.setUserAgent(CHROME_UA);

    // Interception des requêtes sortantes : on réécrit UA + sec-ch-ua pour
    // masquer Electron sur TOUTES les requêtes (webview + fenêtre login).
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders || {};
      headers['User-Agent'] = CHROME_UA;
      headers['sec-ch-ua'] = '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"';
      headers['sec-ch-ua-mobile'] = '?0';
      headers['sec-ch-ua-platform'] = '"Windows"';
      callback({ requestHeaders: headers });
    });

    aiStudioSessionConfigured = true;
  } catch (err) {
    console.error('❌ configureAiStudioSession échoué :', err);
  }
}

// Fenêtre de connexion Google dédiée pour AI Studio.
// Le <webview> Electron est bloqué par Google pour la connexion OAuth
// ("Ce navigateur ou cette application ne sont peut-être pas sécurisés").
// On ouvre donc une vraie BrowserWindow, dans la MÊME partition persistante
// que le <webview> ("persist:aistudio") : une fois connecté ici, la session/
// cookies sont partagés avec le webview de l'onglet IA Studio.
let aiStudioLoginWindow = null;

ipcMain.on('aistudio:openLogin', (event, url) => {
  if (aiStudioLoginWindow && !aiStudioLoginWindow.isDestroyed()) {
    aiStudioLoginWindow.focus();
    return;
  }

  configureAiStudioSession();

  // Validation de l'URL : cette fenêtre a contextIsolation DÉSACTIVÉ (pour le
  // spoofing navigator). On ne peut donc y charger QUE des URL Google en https.
  // Le `url` provient du webview IA Studio (getURL()), influencé par la
  // navigation — sans ce filtrage, une URL arbitraire/file: pourrait être
  // chargée dans une fenêtre aux settings relâchés. Tout ce qui n'est pas
  // https *.google.com retombe sur la page AI Studio par défaut.
  const AI_STUDIO_DEFAULT = 'https://aistudio.google.com/';
  let target = AI_STUDIO_DEFAULT;
  if (typeof url === 'string' && url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' && (/^(?:[a-z0-9-]+\.)?google\.com$/i.test(parsed.hostname))) {
        target = parsed.href;
      } else {
        console.warn(`[aistudio:openLogin] URL non autorisée (host/schéma), repli sur défaut : ${url}`);
      }
    } catch {
      console.warn(`[aistudio:openLogin] URL invalide, repli sur défaut : ${url}`);
    }
  }

  aiStudioLoginWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    title: 'Connexion Google — AI Studio',
    autoHideMenuBar: true,
    webPreferences: {
      // contextIsolation DÉSACTIVÉ sur cette fenêtre (qui ne charge QUE Google)
      // pour permettre au preload d'override navigator.userAgentData / webdriver
      // avant les scripts de Google. nodeIntegration reste false : pas d'accès
      // Node dans la page, seul le preload (fichier local maîtrisé) s'exécute.
      contextIsolation: false,
      nodeIntegration: false,
      partition: AI_STUDIO_PARTITION,
      preload: path.join(__dirname, 'aistudioLoginPreload.js'),
    },
  });

  aiStudioLoginWindow.webContents.setUserAgent(CHROME_UA);

  aiStudioLoginWindow.loadURL(target).catch((err) => {
    console.error('❌ Impossible de charger la fenêtre de connexion AI Studio :', err);
  });

  aiStudioLoginWindow.on('closed', () => {
    aiStudioLoginWindow = null;
  });
});

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
      webviewTag: true,
    },
  });

  const indexPath = path.join(__dirname, '../renderer/index.html');
  console.log('Chargement du fichier HTML :', indexPath);

  mainWindow.loadFile(indexPath).catch((err) => {
    console.error('❌ Impossible de charger index.html :', err);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

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
  // Configure la partition IA Studio (UA Chrome + sec-ch-ua) AVANT la création
  // de la fenêtre : le <webview> de l'onglet IA Studio charge aistudio.google.com
  // dès le démarrage. Sans cela, la première requête partait avec l'UA par défaut
  // (contenant "Electron") → Google détectait Electron et servait une page
  // blanche/bloquée (« effet blanc »). La fenêtre de connexion configurait cette
  // partition trop tard (uniquement à l'ouverture de la fenêtre 🔑).
  configureAiStudioSession();
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

// Verrouille les <webview> créés dynamiquement par le renderer. webviewTag:true
// est activé sur la fenêtre principale, donc sans ce handler un renderer
// compromis pourrait créer un <webview> avec nodeIntegration:true et contourner
// tout le sandboxing. On force les webpreferences sûres sur TOUS les webview.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (_e, webPreferences, params) => {
    // Allowlist du preload AI Studio : le <webview> de l'onglet IA Studio charge
    // aistudioLoginPreload.js (fichier local maîtrisé) qui masque l'empreinte
    // Electron (navigator.userAgentData / webdriver / chrome) AVANT les scripts
    // de Google pour qu'AI Studio s'affiche normalement. Ce preload nécessite
    // contextIsolation=false pour pouvoir modifier les objets de la page.
    // Sans cet allowlist, le hardening supprimait le preload → AI Studio voyait
    // Electron et ne s'affichait pas correctement.
    const aiStudioPreload = 'aistudioLoginPreload.js';
    const isAiStudioPreload = !!(params && params.preload && String(params.preload).endsWith(aiStudioPreload));

    if (!isAiStudioPreload) {
      // Tout preload non autorisé est supprimé (sécurité : un renderer
      // compromis ne peut pas injecter son propre preload).
      delete webPreferences.preload;
      webPreferences.contextIsolation = true;
    } else {
      // Preload de confiance : il a besoin de contextIsolation=false pour
      // surcharger navigator avant les scripts Google. nodeIntegration reste
      // false (pas d'accès Node dans la page).
      webPreferences.contextIsolation = false;
    }
    // Verrouille systématiquement : pas de Node.js dans le webview.
    webPreferences.nodeIntegration = false;
    webPreferences.webSecurity = true;
    // Le webview AI Studio (preload allowlisté) garde contextIsolation=false pour
    // que son preload puisse masquer l'empreinte Electron (navigator.userAgentData
    // etc.) avant les scripts Google. On ne force PAS sandbox=true dessus : la
    // fenêtre de connexion (qui marche) n'a pas non plus sandbox, et sandbox +
    // contextIsolation=false peut empêcher le preload d'overrider navigator →
    // Google voit Electron → page blanche. Les autres webview restent sandboxés.
    if (!isAiStudioPreload) {
      webPreferences.sandbox = true;
    }
    // Isole chaque webview non-AI-Studio dans sa propre session (pas d'accès
    // au cache/cookies app). Le webview AI Studio garde sa partition
    // persist:aistudio (partagée avec la fenêtre de connexion Google).
    if (!isAiStudioPreload && (!params.partition || params.partition === 'persist:default')) {
      webPreferences.partition = 'webview-sandbox';
    }
  });
});