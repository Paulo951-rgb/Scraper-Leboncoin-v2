'use strict';

/**
 * Persistance légère des paramètres utilisateur (durée de rétention HAR, etc.).
 * Extrait d'ipcHandlers.js pour séparer la persistance (infrastructure de config)
 * du routage IPC (cœur applicatif).
 */
const path = require('path');
const fs = require('fs');
const { atomicWriteFileSync } = require('../utils/helpers');

let _settingsPath = null;
function getSettingsPath() {
  if (_settingsPath) return _settingsPath;
  let base;
  try {
    const { app } = require('electron');
    base = app.getPath('userData');
  } catch {
    base = path.join(process.cwd(), 'output');
  }
  _settingsPath = path.join(base, 'user-settings.json');
  return _settingsPath;
}
const SETTINGS_DEFAULTS = Object.freeze({
  autoCleanHarDays: 7,
  scrapeSpeed: 'fast',      // 'fast' | 'balanced' | 'safe'
  pageDelayMs: 1000,        // délai entre les pages de recherche
  headless: true,           // navigateur invisible (sauf CAPTCHA)
  aiConcurrency: 5,         // nb d'annonces analysées en parallèle par l'IA
  logRetentionDays: 7,      // rétention des logs rotatifs (jours)
  autoCleanJobsDays: 0,     // 0 = désactivé ; sinon nb de jours avant suppression auto des jobs
});

function loadSettings() {
  try {
    if (!fs.existsSync(getSettingsPath())) return { ...SETTINGS_DEFAULTS };
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'));
    return { ...SETTINGS_DEFAULTS, ...(data && typeof data === 'object' ? data : {}) };
  } catch (err) {
    console.warn('Lecture paramètres impossible :', err.message);
    return { ...SETTINGS_DEFAULTS };
  }
}

function saveSettings(patch) {
  const merged = { ...loadSettings(), ...(patch && typeof patch === 'object' ? patch : {}) };
  try {
    fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
    // Écriture atomique : un crash pendant fs.writeFileSync laissait
    // user-settings.json tronqué → tous les réglages perdus au redémarrage.
    atomicWriteFileSync(getSettingsPath(), JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.warn('Sauvegarde paramètres impossible :', err.message);
  }
  return merged;
}

module.exports = { loadSettings, saveSettings, SETTINGS_DEFAULTS };
