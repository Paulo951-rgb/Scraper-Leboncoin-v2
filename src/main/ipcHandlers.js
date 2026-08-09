'use strict';

const path = require('path');
const fs = require('fs');
const { ipcMain } = require('electron');
const { HarCapturer } = require('./modules/harCapturer');
const { PipelineRunner } = require('./modules/pipelineRunner');
const { FileManager } = require('./modules/fileManager');
const { JobHistoryManager } = require('./modules/jobHistory');
const { StorageCleaner } = require('./modules/storageCleaner');
const { ExcelExporter } = require('./modules/excelExporter');
const { MarketAnalyzer } = require('./modules/marketAnalyzer');
const { JobSchedulerManager } = require('./modules/jobScheduler');

function setupIpcHandlers(mainWindow) {
  let activeCapturer = null;
  let activeRunner = null;
  let isRunning = false;

  const scheduler = new JobSchedulerManager((config) => {
    mainWindow.webContents.send('scheduler:trigger', config);
  });

  setTimeout(() => {
    StorageCleaner.cleanOldHars(7);
  }, 3000);

  const sendLog = (data) => mainWindow.webContents.send('log', data);
  const sendProgress = (data) => mainWindow.webContents.send('progress', data);
  const sendStatus = (status) => mainWindow.webContents.send('status', status);

  ipcMain.on('job:start', async (event, config) => {
    if (isRunning) return;
    isRunning = true;

    const { searchUrl, pages = 1, noDesc = false, csv = true, autoAiMarket = true, limit, aiConfig, proxyUrl } = config;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jobDir = path.join(process.cwd(), 'output', 'jobs', `job-${timestamp}`);
    const harPath = path.join(jobDir, 'capture.har');
    const resultsDir = path.join(jobDir, 'results');

    let stoppedEarly = false;

    try {
      sendStatus({ state: 'capturing', message: 'Capture HAR automatique en cours...' });
      sendLog({ level: 'info', message: '--- DÉMARRAGE DU SCRAPING ---' });

      activeCapturer = new HarCapturer({ headless: true, proxyUrl }); // 🟢 CHANGÉ EN true : Le navigateur sera 100% invisible

      activeCapturer.on('log', sendLog);
      activeCapturer.on('progress', ({ currentPage, totalPages, percent, status }) => {
        sendProgress({ percent: Math.round(percent * 0.25), status: `[HAR] ${status}` });
      });

      await activeCapturer.capture({
        searchUrl,
        maxPages: parseInt(pages, 10),
        outputHarPath: harPath,
      });

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

      await activeRunner.run({
        harPath,
        outDir: resultsDir,
        noDesc,
        csv,
        limit: limit ? parseInt(limit, 10) : undefined,
      });

      activeRunner = null;

      const jsonPath = path.join(resultsDir, 'annonces.json');
      const xlsxPath = path.join(resultsDir, 'annonces.xlsx');

      if (fs.existsSync(jsonPath)) {
        let ads = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

        // 🧠 ANALYSE IA CONDITIONNELLE (Seulement si coche activée)
        if (autoAiMarket) {
          sendStatus({ state: 'processing', message: 'Analyse du marché IA multi-sources...' });
          sendLog({ level: 'info', message: '🧠 Lancement de l\'Analyse de Marché IA Multi-Sources...' });

          ads = await MarketAnalyzer.analyzeAds(ads, aiConfig, (prog) => {
            sendProgress({
              percent: 75 + Math.round((prog.percent / 100) * 25),
              status: prog.status,
            });
          });

          fs.writeFileSync(jsonPath, JSON.stringify(ads, null, 2));
        }

        await ExcelExporter.exportToXlsx(ads, xlsxPath);
        sendLog({ level: 'info', message: '📊 Export Excel (.xlsx) généré avec succès !' });

        const goodDeals = ads.filter((a) => a.marketAnalysis?.classification === 'Très bonne affaire');
        if (goodDeals.length > 0) {
          JobSchedulerManager.notifyGoodDeal(goodDeals[0]);
        }
      }

      const latestJob = JobHistoryManager.getLatestJob();

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
    const targetJob = jobs.find((j) => j.id === jobId) || jobs[0];

    if (!targetJob || !targetJob.files.json) {
      throw new Error('Aucun fichier de résultats trouvé pour ce job.');
    }

    let ads = JSON.parse(fs.readFileSync(targetJob.files.json, 'utf8'));

    ads = await MarketAnalyzer.analyzeAds(ads, aiConfig, (prog) => {
      sendProgress({ percent: prog.percent, status: prog.status });
    });

    fs.writeFileSync(targetJob.files.json, JSON.stringify(ads, null, 2));
    if (targetJob.files.xlsx) {
      await ExcelExporter.exportToXlsx(ads, targetJob.files.xlsx);
    }

    return JobHistoryManager.getLatestJob();
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
      FileManager.openFolder(folderPath || 'output');
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
}

module.exports = { setupIpcHandlers };