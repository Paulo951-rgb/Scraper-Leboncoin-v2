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
}

module.exports = { StorageCleaner };