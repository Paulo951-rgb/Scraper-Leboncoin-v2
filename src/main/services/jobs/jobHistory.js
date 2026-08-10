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
      const csvPath = path.join(resultsDir, 'annonces.csv');
      const xlsxPath = path.join(resultsDir, 'annonces.xlsx');
      const txtPath = path.join(resultsDir, 'annonces.txt');
      const rapportPath = path.join(resultsDir, 'rapport.txt');

      let rawAds = [];
      let dateFormatted = entry.name.replace('job-', '').replace(/T/, ' à ').replace(/-/g, ':').slice(0, 18);
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
          csv: fs.existsSync(csvPath) ? csvPath : null,
          xlsx: fs.existsSync(xlsxPath) ? xlsxPath : null,
          txt: fs.existsSync(txtPath) ? txtPath : null,
          rapport: fs.existsSync(rapportPath) ? rapportPath : null,
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
    const jobsDir = this.getJobsDir();
    const jobPath = path.join(jobsDir, jobId);

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