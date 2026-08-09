'use strict';

const path = require('path');
const fs = require('fs');
const { ipcMain, shell } = require('electron');
const { HarCapturer } = require('../services/scraping/harCapturer');
const { PipelineRunner } = require('../services/scraping/pipelineRunner');
const { FileManager } = require('../infrastructure/fileManager');
const { JobHistoryManager } = require('../services/jobs/jobHistory');
const { StorageCleaner } = require('../services/maintenance/storageCleaner');
const { ExcelExporter } = require('../infrastructure/excelExporter');
const { MarketAnalyzer } = require('../services/ai/marketAnalyzer');
const { JobSchedulerManager } = require('../services/jobs/jobScheduler');
const { GlobalAnalyzer } = require('../services/ai/globalAnalyzer');
const { Notifier } = require('../infrastructure/notifications');
const { JOBS_DIR, BASE_OUT_DIR } = require('../config/constants');
const { redact, summarizeAds, formatBytes, describeError } = require('../utils/diagnostics');
const { loadSettings, saveSettings } = require('./settings');

function setupIpcHandlers(mainWindow) {
  let activeCapturer = null;
  let activeRunner = null;
  let isRunning = false;

  const scheduler = new JobSchedulerManager((config) => {
    mainWindow.webContents.send('scheduler:trigger', config);
  });

  const settings = loadSettings();
  setTimeout(() => {
    StorageCleaner.cleanOldHars(settings.autoCleanHarDays || 7);
  }, 3000);

  const sendLog = (data) => mainWindow.webContents.send('log', data);
  const sendProgress = (data) => mainWindow.webContents.send('progress', data);
  const sendStatus = (status) => mainWindow.webContents.send('status', status);

  ipcMain.on('job:start', async (event, config) => {
    if (isRunning) {
      sendLog({ level: 'warn', message: '[job:start] Un job est déjà en cours — requête ignorée.' });
      return;
    }
    isRunning = true;

    const { searchUrl, pages = 1, noDesc = false, csv = true, autoAiMarket = true, limit, aiConfig, proxyUrl } = config;
    const userSettings = loadSettings();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jobDir = path.join(JOBS_DIR, `job-${timestamp}`);
    const harPath = path.join(jobDir, 'capture.har');
    const resultsDir = path.join(jobDir, 'results');

    sendLog({ level: 'debug', message: `[job:start] Config reçue — searchUrl=${searchUrl} | pages=${pages} | noDesc=${noDesc} | csv=${csv} | autoAiMarket=${autoAiMarket} | limit=${limit ?? '(aucun)'} | proxy=${proxyUrl || 'aucun'} | aiConfig.provider=${aiConfig?.provider || '?'} | aiConfig.apiKey=${redact(aiConfig?.apiKey)}` });
    sendLog({ level: 'debug', message: `[job:start] Dossiers — jobDir=${jobDir} | harPath=${harPath} | resultsDir=${resultsDir}` });

    let stoppedEarly = false;

    try {
      sendStatus({ state: 'capturing', message: 'Capture HAR automatique en cours...' });
      sendLog({ level: 'info', message: '--- DÉMARRAGE DU SCRAPING ---' });
      const t0Total = Date.now();

      // Le HarCapturer gère lui-même la bascule headless/visible (pré-check captcha).
      const pageDelay = parseInt(userSettings.pageDelayMs, 10) || 1000;
      activeCapturer = new HarCapturer({
        proxyUrl,
        headless: userSettings.headless !== false,
        minPageDelayMs: pageDelay,
        maxPageDelayMs: pageDelay + 700,
      });
      sendLog({ level: 'debug', message: `[job:start] Vitesse=${userSettings.scrapeSpeed} | headless=${userSettings.headless !== false} | délai pages=${pageDelay}ms` });

      activeCapturer.on('log', sendLog);
      activeCapturer.on('progress', ({ currentPage, totalPages, percent, status }) => {
        sendProgress({ percent: Math.round(percent * 0.25), status: `[HAR] ${status}` });
      });

      await activeCapturer.capture({
        searchUrl,
        maxPages: parseInt(pages, 10),
        outputHarPath: harPath,
      });
      const harElapsed = Date.now() - t0Total;
      sendLog({ level: 'debug', message: `[job:start] Phase capture HAR terminée en ${Math.round(harElapsed / 1000)}s. Taille HAR : ${fs.existsSync(harPath) ? formatBytes(fs.statSync(harPath).size) : '(introuvable)'}.` });

      activeCapturer = null;

      sendStatus({ state: 'processing', message: 'Extraction et enrichissement des annonces...' });

      activeRunner = new PipelineRunner();

      activeRunner.on('log', (data) => {
        sendLog(data);
        // 🟢 FIX : Détection d'interruption élargie (prend en compte "interrompu" et "restreint")
        if (data.message && (data.message.includes('interrompu') || data.message.includes('restreint'))) {
          stoppedEarly = true;
        }
      });

      activeRunner.on('progress', ({ percent, status, eta }) => {
        const globalPercent = 25 + Math.round((percent / 100) * 50);
        sendProgress({ percent: globalPercent, status, eta });
      });

      const t0Pipeline = Date.now();
      await activeRunner.run({
        harPath,
        outDir: resultsDir,
        noDesc,
        csv,
        limit: limit ? parseInt(limit, 10) : undefined,
        speed: userSettings.scrapeSpeed || 'fast',
        headless: userSettings.headless !== false,
      });
      sendLog({ level: 'debug', message: `[job:start] Phase pipeline terminée en ${Math.round((Date.now() - t0Pipeline) / 1000)}s.` });

      activeRunner = null;

      const jsonPath = path.join(resultsDir, 'annonces.json');
      const xlsxPath = path.join(resultsDir, 'annonces.xlsx');

      if (fs.existsSync(jsonPath)) {
        let ads = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        sendLog({ level: 'debug', message: `[job:start] annonces.json lu : ${summarizeAds(ads)}.` });

        // 🧠 ANALYSE IA CONDITIONNELLE (Seulement si coche activée)
        if (autoAiMarket) {
          sendStatus({ state: 'processing', message: 'Analyse du marché IA multi-sources...' });
          sendLog({ level: 'info', message: `🧠 Lancement de l'Analyse de Marché IA Multi-Sources (${ads.length} annonces, parallèle x${aiConfig.concurrency || 5})...` });

          const t0Ai = Date.now();
          const aiLog = (msg, level = 'debug') => sendLog({ level, message: `[IA] ${msg}` });
          ads = await MarketAnalyzer.analyzeAds(ads, { ...aiConfig, concurrency: userSettings.aiConcurrency || 5, _log: aiLog }, (prog) => {
            sendProgress({
              percent: 75 + Math.round((prog.percent / 100) * 25),
              status: prog.status,
            });
          });
          const aiElapsed = Math.round((Date.now() - t0Ai) / 1000);
          sendLog({ level: 'info', message: `✅ Analyse IA terminée en ${aiElapsed}s (${ads.length} annonces).` });
          sendLog({ level: 'debug', message: `[job:start] Phase analyse IA terminée en ${aiElapsed}s.` });

          fs.writeFileSync(jsonPath, JSON.stringify(ads, null, 2));
        } else {
          sendLog({ level: 'debug', message: '[job:start] Analyse IA ignorée (autoAiMarket=false).' });
        }

        await ExcelExporter.exportToXlsx(ads, xlsxPath);
        sendLog({ level: 'info', message: '📊 Export Excel (.xlsx) généré avec succès !' });

        const goodDeals = ads.filter((a) => a.marketAnalysis?.classification === 'Très bonne affaire');
        if (goodDeals.length > 0) {
          sendLog({ level: 'debug', message: `[job:start] ${goodDeals.length} "Très bonne affaire" détectée(s) — notification déclenchée pour la 1ère : "${(goodDeals[0].title || '').slice(0, 40)}".` });
          Notifier.notifyGoodDeal(goodDeals[0]);
        } else {
          sendLog({ level: 'debug', message: '[job:start] Aucune "Très bonne affaire" détectée dans ce dataset.' });
        }
      } else {
        sendLog({ level: 'warn', message: `[job:start] annonces.json introuvable après pipeline : ${jsonPath} — le scraping a peut-être échoué silencieusement.` });
      }

      const latestJob = JobHistoryManager.getLatestJob();
      sendLog({ level: 'debug', message: `[job:start] Durée totale du job : ${Math.round((Date.now() - t0Total) / 1000)}s | stoppedEarly=${stoppedEarly}.` });

      if (stoppedEarly) {
        sendProgress({ percent: 100, status: 'Sauvegardé (Interruption préventive IP)' });
        sendStatus({
          state: 'completed',
          message: 'Scraping partiellement terminé (données acquises sauvegardées).',
          latestJob,
        });
      } else {
        sendProgress({ percent: 100, status: 'Terminé à 100 % !' });
        sendStatus({
          state: 'completed',
          message: 'Scraping terminé avec succès !',
          latestJob,
        });
      }

    } catch (err) {
      sendLog({ level: 'error', message: `❌ Erreur : ${err.message}` });
      sendLog({ level: 'debug', message: `[job:start] Détail erreur fatale : ${describeError(err)}` });
      sendStatus({ state: 'error', message: `Erreur : ${err.message}` });
    } finally {
      isRunning = false;
      activeCapturer = null;
      activeRunner = null;
    }
  });

  ipcMain.on('job:stop', () => {
    if (!isRunning) return;
    sendLog({ level: 'warn', message: 'Demande d\'arrêt utilisateur envoyée...' });
    if (activeRunner) activeRunner.stop();
    if (activeCapturer) activeCapturer.stop(); // 🟢 FIX : Arrêt immédiat de la capture HAR en cours
  });

  ipcMain.handle('market:analyze', async (event, { jobId, aiConfig }) => {
    const jobs = JobHistoryManager.listAllJobs();
    const targetJob = jobs.find((j) => j.id === jobId);

    if (!targetJob) {
      throw new Error(`Job introuvable (id: ${jobId}). Aucune analyse possible.`);
    }
    if (!targetJob.files.json) {
      throw new Error('Aucun fichier de résultats trouvé pour ce job.');
    }

    let ads = JSON.parse(fs.readFileSync(targetJob.files.json, 'utf8'));

    const reanalyzeSettings = loadSettings();
    const aiLog2 = (msg, level = 'debug') => sendLog({ level, message: `[IA] ${msg}` });
    ads = await MarketAnalyzer.analyzeAds(ads, { ...aiConfig, concurrency: reanalyzeSettings.aiConcurrency || 5, _log: aiLog2 }, (prog) => {
      sendProgress({ percent: prog.percent, status: prog.status });
    });

    fs.writeFileSync(targetJob.files.json, JSON.stringify(ads, null, 2));
    if (targetJob.files.xlsx) {
      await ExcelExporter.exportToXlsx(ads, targetJob.files.xlsx);
    }

    return JobHistoryManager.getLatestJob();
  });

  ipcMain.handle('globalai:analyze', async (event, { jobId, presetKey, customInstruction, geminiApiKey, geminiModel }) => {
    if (!geminiApiKey) throw new Error('Clé API Gemini manquante.');

    const jobs = JobHistoryManager.listAllJobs();
    let ads = [];

    if (!jobId || jobId === 'ALL') {
      jobs.forEach((j) => {
        if (Array.isArray(j.ads)) ads.push(...j.ads);
      });
    } else {
      const job = jobs.find((j) => j.id === jobId);
      if (!job) throw new Error(`Job introuvable (id: ${jobId}).`);
      ads = Array.isArray(job.ads) ? job.ads : [];
    }

    if (ads.length === 0) throw new Error('Aucune annonce à analyser dans ce dataset.');

    sendStatus({ state: 'processing', message: 'Analyse Globale Gemini en cours...' });

    const report = await GlobalAnalyzer.analyze(ads, {
      presetKey,
      customInstruction,
      geminiApiKey,
      geminiModel: geminiModel || 'gemini-2.0-flash',
    }, (prog) => {
      sendProgress({ percent: prog.percent, status: prog.status });
    });

    return report;
  });

  ipcMain.handle('config:get', async () => {
    return loadSettings();
  });

  ipcMain.handle('config:save', async (event, patch) => {
    return saveSettings(patch);
  });

  ipcMain.handle('scheduler:add', async (event, task) => {
    scheduler.addSchedule(task);
    return scheduler.listSchedules();
  });

  ipcMain.handle('scheduler:remove', async (event, id) => {
    scheduler.removeSchedule(id);
    return scheduler.listSchedules();
  });

  ipcMain.handle('scheduler:list', async () => {
    return scheduler.listSchedules();
  });

  ipcMain.handle('job:getHistory', async () => {
    return JobHistoryManager.listAllJobs();
  });

  ipcMain.handle('job:delete', async (event, jobId) => {
    return JobHistoryManager.deleteJob(jobId);
  });

  ipcMain.handle('file:openFolder', async (event, folderPath) => {
    try {
      const target = folderPath || BASE_OUT_DIR;
      FileManager.openFolder(target);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('file:openFile', async (event, filePath) => {
    try {
      FileManager.openFile(filePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('shell:openExternal', async (event, url) => {
    try {
      if (!url) return { success: false, error: 'URL vide' };
      await shell.openExternal(url);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = { setupIpcHandlers };