'use strict';

const path = require('path');
const { app } = require('electron');

// Définition du dossier de base (Documents pour l'exe, dossier local pour le dev)
const isPackaged = app.isPackaged;
const BASE_OUT_DIR = isPackaged 
  ? path.join(app.getPath('documents'), 'Leboncoin Scraper Pro')
  : path.join(process.cwd(), 'output');

// 🔑 Chemin unique pour la session globale (Master Session)
const GLOBAL_SESSION_PATH = path.join(BASE_OUT_DIR, 'global-session.json');

// 📁 Répertoires centralisés (cohérents en dev ET en version packagée .exe)
const JOBS_DIR = path.join(BASE_OUT_DIR, 'jobs');
const RESULTS_DIR = path.join(JOBS_DIR, 'results');

module.exports = {
  APP_NAME: 'Leboncoin Scraper Pro',
  BASE_OUT_DIR,
  JOBS_DIR,
  RESULTS_DIR,
  DEFAULTS: {
    minDelayMs: 1200,
    maxDelayMs: 2500,
    headless: false,
    outDir: BASE_OUT_DIR,
    autoAiMarket: true,
  },
  THEMES: ['theme-dark', 'theme-light', 'theme-oled', 'theme-blue', 'theme-green', 'theme-violet'],
  RISK_KEYWORDS: [
    'hs', 'pour pièces', 'pour pieces', 'panne', 'non testé', 'non teste',
    'à réparer', 'a reparer', 'cassé', 'casse', 'sans chargeur', 'fissuré',
    'incomplet', 'défectueux', 'defectueux'
  ],
  GLOBAL_SESSION_PATH,
};