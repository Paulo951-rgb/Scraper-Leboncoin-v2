'use strict';

const fs = require('fs');
const path = require('path');
const { JOBS_DIR } = require('../../config/constants');

class StorageCleaner {
  /**
   * Nettoie les fichiers .har de plus de `maxDays` jours dans output/
   */
  static cleanOldHars(maxDays = 7) {
    const jobsDir = JOBS_DIR;
    if (!fs.existsSync(jobsDir)) {
      console.log(`[StorageCleaner] Dossier jobs introuvable : ${jobsDir} — rien à nettoyer.`);
      return 0;
    }

    const now = Date.now();
    const maxAgeMs = maxDays * 24 * 60 * 60 * 1000;
    let deletedCount = 0;
    let scannedCount = 0;

    try {
      const entries = fs.readdirSync(jobsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const harPath = path.join(jobsDir, entry.name, 'capture.har');
        if (fs.existsSync(harPath)) {
          scannedCount++;
          const stats = fs.statSync(harPath);
          const ageDays = Math.floor((now - stats.mtimeMs) / (24 * 60 * 60 * 1000));
          if (now - stats.mtimeMs > maxAgeMs) {
            fs.unlinkSync(harPath);
            deletedCount++;
            console.log(`[StorageCleaner] HAR supprimé : ${harPath} (${ageDays} jours, > ${maxDays}j).`);
          }
        }
      }
      console.log(`[StorageCleaner] Nettoyage terminé : ${scannedCount} HAR scanné(s) | ${deletedCount} supprimé(s) (> ${maxDays} jours) dans ${jobsDir}.`);
    } catch (err) {
      console.error('[StorageCleaner] Erreur lors du nettoyage des fichiers HAR :', err.message);
    }

    return deletedCount;
  }

  /**
   * Nettoie les dossiers de jobs (job-*) de plus de `maxDays` jours.
   * Supprime entièrement le dossier job-<timestamp> (HAR + résultats + session).
   * @param {number} maxDays Âge maximum en jours (0 = désactivé).
   * @returns {number} Nombre de jobs supprimés.
   */
  static cleanOldJobs(maxDays = 0) {
    if (!maxDays || maxDays <= 0) return 0;

    const jobsDir = JOBS_DIR;
    if (!fs.existsSync(jobsDir)) {
      console.log(`[StorageCleaner] Dossier jobs introuvable : ${jobsDir} — rien à nettoyer.`);
      return 0;
    }

    const now = Date.now();
    const maxAgeMs = maxDays * 24 * 60 * 60 * 1000;
    let deletedCount = 0;
    let scannedCount = 0;

    try {
      const entries = fs.readdirSync(jobsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('job-')) continue;
        scannedCount++;
        const jobPath = path.join(jobsDir, entry.name);
        const stats = fs.statSync(jobPath);
        const ageDays = Math.floor((now - stats.mtimeMs) / (24 * 60 * 60 * 1000));
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.rmSync(jobPath, { recursive: true, force: true });
          deletedCount++;
          console.log(`[StorageCleaner] Job supprimé : ${entry.name} (${ageDays} jours, > ${maxDays}j).`);
        }
      }
      console.log(`[StorageCleaner] Nettoyage jobs : ${scannedCount} scanné(s) | ${deletedCount} supprimé(s) (> ${maxDays} jours) dans ${jobsDir}.`);
    } catch (err) {
      console.error('[StorageCleaner] Erreur lors du nettoyage des jobs :', err.message);
    }

    return deletedCount;
  }
}

module.exports = { StorageCleaner };