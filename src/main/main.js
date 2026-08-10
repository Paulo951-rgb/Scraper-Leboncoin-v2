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

  const target = (typeof url === 'string' && url) || 'https://aistudio.google.com/';

  aiStudioLoginWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    title: 'Connexion Google — AI Studio',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: AI_STUDIO_PARTITION,
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
  if (setupIpcHandlers) setupIpcHandlers(getMainWindow);
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