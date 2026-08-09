'use strict';

/**
 * Persistance légère des paramètres utilisateur (durée de rétention HAR, etc.).
 * Extrait d'ipcHandlers.js pour séparer la persistance (infrastructure de config)
 * du routage IPC (cœur applicatif).
 */
const path = require('path');
const fs = require('fs');

const SETTINGS_PATH = path.join(__dirname, '..', 'config', 'user-settings.json');
const SETTINGS_DEFAULTS = Object.freeze({
  autoCleanHarDays: 7,
  scrapeSpeed: 'fast',      // 'fast' | 'balanced' | 'safe'
  pageDelayMs: 1000,        // délai entre les pages de recherche
  headless: true,           // navigateur invisible (sauf CAPTCHA)
});

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return { ...SETTINGS_DEFAULTS };
    const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return { ...SETTINGS_DEFAULTS, ...(data && typeof data === 'object' ? data : {}) };
  } catch (err) {
    console.warn('Lecture paramètres impossible :', err.message);
    return { ...SETTINGS_DEFAULTS };
  }
}

function saveSettings(patch) {
  const merged = { ...loadSettings(), ...(patch && typeof patch === 'object' ? patch : {}) };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.warn('Sauvegarde paramètres impossible :', err.message);
  }
  return merged;
}

module.exports = { loadSettings, saveSettings, SETTINGS_DEFAULTS };
