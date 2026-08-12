'use strict';

const fs = require('fs');
const path = require('path');
const { AdStats } = require('../analysis/adStats');
const { JOBS_DIR } = require('../../config/constants');
const { readWithChecksum } = require('../../utils/integrity');

class JobHistoryManager {
  static getJobsDir() {
    return JOBS_DIR;
  }

  static listAllJobs() {
    const jobsDir = this.getJobsDir();
    if (!fs.existsSync(jobsDir)) {
      console.log(`[JobHistory] Dossier jobs introuvable : ${jobsDir} — retour liste vide.`);
      return [];
    }

    const entries = fs.readdirSync(jobsDir, { withFileTypes: true });
    const jobDirs = entries.filter((e) => e.isDirectory() && e.name.startsWith('job-'));
    console.log(`[JobHistory] Scan de ${jobsDir} : ${entries.length} entrée(s), ${jobDirs.length} dossier(s) job- trouvés.`);
    const jobs = [];

    for (const entry of jobDirs) {
      const jobPath = path.join(jobsDir, entry.name);
      const resultsDir = path.join(jobPath, 'results');
      const jsonPath = path.join(resultsDir, 'annonces.json');
      const xlsxPath = path.join(resultsDir, 'annonces.xlsx');
      const txtPath = path.join(resultsDir, 'annonces.txt');
      const resumesPath = path.join(resultsDir, 'resumes-ia.json');

      let rawAds = [];
      // Formatage lisible : le nom du dossier est job-<ISO> (ex: job-2026-08-12T02-21-16-123Z).
      // On veut afficher « 12/08/2026 à 02:21 » (date française HH:MM, sans les ms ni
      // les secondes tronquées au milieu). L'ancien code remplaçait tous les '-' par
      // ':' → « 2026:08:12 à 02:21 » (deux-points dans la date, illisible).
      const tsMatch = entry.name.match(/^job-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
      const dateFormatted = tsMatch
        ? `${tsMatch[3]}/${tsMatch[2]}/${tsMatch[1]} à ${tsMatch[4]}:${tsMatch[5]}`
        : entry.name.replace('job-', '');
      let integrityWarning = null;

      if (fs.existsSync(jsonPath)) {
        const { data, valid, reason } = readWithChecksum(jsonPath);
        if (!valid) {
          console.warn(`[JobHistory] Intégrité compromise pour ${entry.name} : ${reason} — annonces ignorées.`);
          integrityWarning = reason;
          rawAds = [];
        } else {
          rawAds = data || [];
        }
      } else {
        console.debug(`[JobHistory] ${entry.name} : pas d'annonces.json (résultats absents).`);
      }

      const { stats, ads: enrichedAds } = AdStats.analyze(rawAds);

      jobs.push({
        id: entry.name,
        date: dateFormatted,
        adsCount: rawAds.length,
        stats,
        ads: enrichedAds,
        jobDir: jobPath,
        resultsDir,
        integrityWarning,
        files: {
          json: fs.existsSync(jsonPath) ? jsonPath : null,
          xlsx: fs.existsSync(xlsxPath) ? xlsxPath : null,
          txt: fs.existsSync(txtPath) ? txtPath : null,
          resumes: fs.existsSync(resumesPath) ? resumesPath : null,
        },
      });
    }

    console.log(`[JobHistory] ${jobs.length} job(s) chargé(s) — ${jobs.reduce((s, j) => s + j.adsCount, 0)} annonce(s) au total.`);
    return jobs.sort((a, b) => b.id.localeCompare(a.id));
  }

  static getLatestJob() {
    const jobs = this.listAllJobs();
    const latest = jobs.length > 0 ? jobs[0] : null;
    console.log(`[JobHistory] Dernier job : ${latest ? latest.id + ' (' + latest.adsCount + ' annonces)' : '(aucun)'}.`);
    return latest;
  }

  static deleteJob(jobId) {
    // Validation anti path-traversal : un renderer compromis pourrait passer un
    // jobId contenant '..' ou des séparateurs pour supprimer un dossier arbitraire.
    // On n'autorise que les noms au format job-<timestamp> (alphanum + -).
    if (!jobId || typeof jobId !== 'string' || !/^job-[a-zA-Z0-9-]+$/.test(jobId) || jobId.includes('..')) {
      console.warn(`[JobHistory] ID de job invalide (rejeté) : ${jobId}`);
      return false;
    }
    const jobsDir = this.getJobsDir();
    const jobPath = path.join(jobsDir, jobId);

    // Double-check : le chemin résolu doit bien rester dans JOBS_DIR.
    const resolved = path.resolve(jobPath);
    const baseResolved = path.resolve(jobsDir);
    if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) {
      console.warn(`[JobHistory] Chemin hors JOBS_DIR rejeté : ${resolved}`);
      return false;
    }

    if (fs.existsSync(jobPath)) {
      fs.rmSync(jobPath, { recursive: true, force: true });
      console.log(`[JobHistory] Job supprimé : ${jobId} (${jobPath}).`);
      return true;
    }
    console.warn(`[JobHistory] Suppression impossible — job introuvable : ${jobId} (${jobPath}).`);
    return false;
  }
}

module.exports = { JobHistoryManager };