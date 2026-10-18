'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Nom du dossier de données utilisé par les versions antérieures (avant le
// renommage « Vendra »). Conservé UNIQUEMENT pour la migration : les données
// existantes de l'utilisateur ne doivent jamais être perdues ni dupliquées.
const LEGACY_DIR_NAME = 'Leboncoin Scraper Pro';
const APP_DIR_NAME = 'Vendra';

/**
 * Résout le dossier de données utilisateur en version packagée.
 *
 * Migre `Documents/Leboncoin Scraper Pro` vers `Documents/Vendra` par un simple
 * `rename` (aucune copie, aucune suppression) :
 * - si le nouveau dossier existe déjà, on l'utilise tel quel ;
 * - si seul l'ancien existe, on le renomme (opération atomique) ;
 * - si le renommage échoue (dossier verrouillé), on CONTINUE d'utiliser
 *   l'ancien emplacement : la compatibilité prime sur l'esthétique du chemin.
 */
function resolvePackagedBaseDir() {
  const documents = app.getPath('documents');
  const target = path.join(documents, APP_DIR_NAME);
  const legacy = path.join(documents, LEGACY_DIR_NAME);
  try {
    if (fs.existsSync(target)) return target;
    if (fs.existsSync(legacy)) {
      fs.renameSync(legacy, target);
      return target;
    }
  } catch {
    return legacy;
  }
  return target;
}

// Définition du dossier de base (Documents pour l'exe, dossier local pour le dev)
const BASE_OUT_DIR = app.isPackaged
  ? resolvePackagedBaseDir()
  : path.join(process.cwd(), 'output');

// 🔑 Chemin unique pour la session globale (Master Session)
const GLOBAL_SESSION_PATH = path.join(BASE_OUT_DIR, 'global-session.json');

// 🚫 Marqueur « session restreinte » : créé quand le site a explicitement refusé
// l'accès (page « Accès temporairement restreint »). Tant qu'il existe, la session
// globale n'est PAS réutilisée (elle porterait des cookies anti-bot empoisonnés)
// et Vendra repart d'un contexte vierge. Il est retiré dès qu'un accès normal est
// confirmé. Fichier simple, sans secret (aucun cookie/token dedans).
const RESTRICTED_SESSION_FLAG_PATH = path.join(BASE_OUT_DIR, 'session-restricted.flag');

// 📁 Répertoires centralisés (cohérents en dev ET en version packagée .exe)
const JOBS_DIR = path.join(BASE_OUT_DIR, 'jobs');
// Note: les résultats de chaque job vont dans JOBS_DIR/job-<timestamp>/results
// (calculé dynamiquement par job dans ipcHandlers), il n'y a pas de RESULTS_DIR global.

module.exports = {
  APP_NAME: 'Vendra',
  BASE_OUT_DIR,
  JOBS_DIR,
  // Note: les valeurs par défaut des réglages utilisateur (vitesse, headless,
  // délais, concurrence IA, rétention…) vivent dans core/settings.js
  // (SETTINGS_DEFAULTS). L'ancien bloc DEFAULTS ici était mort ET conflictuel
  // (headless:false ici vs headless:true dans settings) — supprimé pour éviter
  // toute confusion.
  THEMES: ['theme-dark', 'theme-light', 'theme-graphite'],
  GLOBAL_SESSION_PATH,
  RESTRICTED_SESSION_FLAG_PATH,
};