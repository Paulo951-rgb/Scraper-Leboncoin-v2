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
// Note: les résultats de chaque job vont dans JOBS_DIR/job-<timestamp>/results
// (calculé dynamiquement par job dans ipcHandlers), il n'y a pas de RESULTS_DIR global.

module.exports = {
  APP_NAME: 'Leboncoin Scraper Pro',
  BASE_OUT_DIR,
  JOBS_DIR,
  DEFAULTS: {
    minDelayMs: 1200,
    maxDelayMs: 2500,
    headless: false,
    outDir: BASE_OUT_DIR,
    autoAiMarket: true,
  },
  THEMES: ['theme-dark', 'theme-light', 'theme-oled', 'theme-violet', 'theme-green', 'theme-sunset', 'theme-carbon', 'theme-rose', 'theme-amber', 'theme-mint', 'theme-slate', 'theme-crimson', 'theme-nordic'],
  GLOBAL_SESSION_PATH,
};