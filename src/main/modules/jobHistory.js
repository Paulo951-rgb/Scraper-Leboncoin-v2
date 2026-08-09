'use strict';

const fs = require('fs');
const path = require('path');
const { DealFinder } = require('./dealFinder');
const { JOBS_DIR } = require('../config/constants');

class JobHistoryManager {
  static getJobsDir() {
    return JOBS_DIR;
  }

  static listAllJobs() {
    const jobsDir = this.getJobsDir();
    if (!fs.existsSync(jobsDir)) return [];

    const entries = fs.readdirSync(jobsDir, { withFileTypes: true });
    const jobs = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('job-')) continue;

      const jobPath = path.join(jobsDir, entry.name);
      const resultsDir = path.join(jobPath, 'results');
      const jsonPath = path.join(resultsDir, 'annonces.json');
      const csvPath = path.join(resultsDir, 'annonces.csv');
      const xlsxPath = path.join(resultsDir, 'annonces.xlsx');
      const txtPath = path.join(resultsDir, 'annonces.txt');
      const rapportPath = path.join(resultsDir, 'rapport.txt');

      let rawAds = [];
      let dateFormatted = entry.name.replace('job-', '').replace(/T/, ' à ').replace(/-/g, ':').slice(0, 18);

      if (fs.existsSync(jsonPath)) {
        try {
          rawAds = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        } catch {
          rawAds = [];
        }
      }

      const { stats, enrichedAds } = DealFinder.analyze(rawAds);

      jobs.push({
        id: entry.name,
        date: dateFormatted,
        adsCount: rawAds.length,
        stats,
        ads: enrichedAds,
        jobDir: jobPath,
        resultsDir,
        files: {
          json: fs.existsSync(jsonPath) ? jsonPath : null,
          csv: fs.existsSync(csvPath) ? csvPath : null,
          xlsx: fs.existsSync(xlsxPath) ? xlsxPath : null,
          txt: fs.existsSync(txtPath) ? txtPath : null,
          rapport: fs.existsSync(rapportPath) ? rapportPath : null,
        },
      });
    }

    return jobs.sort((a, b) => b.id.localeCompare(a.id));
  }

  static getLatestJob() {
    const jobs = this.listAllJobs();
    return jobs.length > 0 ? jobs[0] : null;
  }

  static deleteJob(jobId) {
    const jobsDir = this.getJobsDir();
    const jobPath = path.join(jobsDir, jobId);

    if (fs.existsSync(jobPath)) {
      fs.rmSync(jobPath, { recursive: true, force: true });
      return true;
    }
    return false;
  }
}

module.exports = { JobHistoryManager };