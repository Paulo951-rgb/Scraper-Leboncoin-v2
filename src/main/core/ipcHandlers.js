'use strict';

const path = require('path');
const fs = require('fs');
const { ipcMain, shell, app } = require('electron');
const { HarCapturer } = require('../services/scraping/harCapturer');
const { PipelineRunner } = require('../services/scraping/pipelineRunner');
const { FileManager } = require('../infrastructure/fileManager');
const { JobHistoryManager } = require('../services/jobs/jobHistory');
const { StorageCleaner } = require('../services/maintenance/storageCleaner');
const { ExcelExporter } = require('../infrastructure/excelExporter');
const { AdAnalyzer } = require('../services/ai/adAnalyzer');
const { MarketValueAnalyzer } = require('../services/ai/marketValueAnalyzer');
const { PromptGenerator } = require('../services/ai/promptGenerator');
const { listTemplates, buildPrompt } = require('../services/ai/promptTemplates');
const { checkOllamaHealth, checkModelAvailable } = require('../services/ai/ollamaHealth');
const { Notifier } = require('../infrastructure/notifications');
const { JOBS_DIR, BASE_OUT_DIR } = require('../config/constants');
const { redact, summarizeAds, formatBytes, describeError } = require('../utils/diagnostics');
const { writeWithChecksum, readWithChecksum } = require('../utils/integrity');
const { atomicWriteFileSync } = require('../utils/helpers');
const { loadSettings, saveSettings } = require('./settings');
const { listSearchProviders } = require('../services/ai/search/searchProviderRegistry');

/**
 * Génère un fichier résumé compact (JSON) destiné à être transmis à une autre IA
 * pour analyse externe. Contient uniquement : numéro, titre, URL, prix, résumé IA.
 * Exclut volontairement la description complète, les photos, la date et les autres
 * infos inutiles — pour garder le fichier léger.
 *
 * Écriture atomique : un crash pendant l'écriture laissait un resumes-ia.json
 * tronvé/corrompu (fs.writeFileSync n'est pas atomique). On passe par
 * atomicWriteFileSync (tmp + rename) — cohérent avec les autres écritures JSON.
 */
function writeSummaryFile(ads, summaryPath) {
  try {
    const summary = ads.map((a, i) => ({
      numero: i + 1,
      titre: a.title || null,
      url: a.url || null,
      prix: a.price != null ? a.price : null,
      resume_ia: (a.adAnalysis && a.adAnalysis.summary) || null,
    }));
    atomicWriteFileSync(summaryPath, JSON.stringify(summary, null, 2));
  } catch (err) {
    console.warn('[writeSummaryFile] Écriture du résumé impossible :', err.message);
  }
}

function setupIpcHandlers(getMainWindow) {
  let activeCapturer = null;
  let activeRunner = null;
  let isRunning = false;
  // Verrou dédié à l'analyse de marché (market:analyze). isRunning ne couvre
  // QUE le cycle job:start ; sans ce second verrou, deux invocations concurrentes
  // de market:analyze (ex: double-clic sur « IA Marché » avant que le bouton ne
  // se désactive) lançaient deux batches IA + deux writeWithChecksum en parallèle
  // sur le MÊME job → race sur le fichier annonces.json et appels IA dupliqués.
  let isMarketAnalyzing = false;

  // Getter de fenêtre principale : renvoie null si détruite/fichermée,
  // évitant les crashes "Cannot read properties of null" sur webContents.send.
  const getWin = () => {
    const w = typeof getMainWindow === 'function' ? getMainWindow() : getMainWindow;
    return w && !w.isDestroyed() ? w : null;
  };

  // Arrêt forcé des opérations en cours (appelé sur before-quit) : stoppe le
  // pipeline forké (SIGINT → le fils ferme son Playwright et exit) et la
  // capture HAR (isCancelled → finally ferme le navigateur). Sans cela, fermer
  // l'app pendant un job laissait le processus fils (leboncoin-pipeline) et son
  // navigateur Chromium orphelins, continuant à tourner en arrière-plan.
  function shutdown() {
    try {
      if (activeRunner) activeRunner.stop();
    } catch { /* shutdown best-effort */ }
    try {
      if (activeCapturer) activeCapturer.stop();
    } catch { /* shutdown best-effort */ }
  }

  const settings = loadSettings();

  const { logger } = require('../utils/logger');
  logger.setRetention(settings.logRetentionDays || 7);

  setTimeout(() => {
    StorageCleaner.cleanOldHars(settings.autoCleanHarDays || 7);
    if (settings.autoCleanJobsDays && settings.autoCleanJobsDays > 0) {
      const purged = StorageCleaner.cleanOldJobs(settings.autoCleanJobsDays);
      if (purged > 0) logger.info(`[startup] ${purged} job(s) ancien(s) supprimé(s) (>${settings.autoCleanJobsDays}j).`);
    }
  }, 3000);

  const sendLog = (data) => { const w = getWin(); if (w) w.webContents.send('log', data); };
  const sendProgress = (data) => { const w = getWin(); if (w) w.webContents.send('progress', data); };
  const sendStatus = (status) => { const w = getWin(); if (w) w.webContents.send('status', status); };

  // ─── Suivi de session pour le résumé de fin de scraping ────────────────────
  // Les compteurs sont incrémentés au fil du job (via l'écoute des logs du
  // pipeline et des phases IA). À la fin, un résumé formaté est envoyé.
  function newSessionStats() {
    return {
      t0: 0, pagesRequested: 0, pagesScraped: 0,
      adsFound: 0, adsKept: 0, adsDuplicates: 0,
      descriptionsExtracted: 0, descriptionsBlocked: 0,
      aiAnalyzed: 0, aiFallback: 0, aiErrors: 0,
      marketAnalyzed: 0, marketFallback: 0,
      errors: 0, warnings: 0, debugs: 0,
      stoppedEarly: false,
    };
  }
  let sessionStats = newSessionStats();
  // Wrapper autour de sendLog qui compte les niveaux pour le résumé.
  const sessionLog = (data) => {
    const level = data.level || 'info';
    if (level === 'error') sessionStats.errors++;
    else if (level === 'warn') sessionStats.warnings++;
    else if (level === 'debug') sessionStats.debugs++;
    sendLog(data);
  };

  function formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  }

  function sendSessionSummary() {
    const dur = Math.round((Date.now() - sessionStats.t0) / 1000);
    const lines = [
      '',
      '═══════════════════════════════════════════════════════════',
      '📋 RÉSUMÉ DE SESSION',
      '═══════════════════════════════════════════════════════════',
      `  ⏱  Durée totale        : ${formatDuration(dur)}`,
      `  📄 Pages demandées      : ${sessionStats.pagesRequested}`,
      `  📄 Pages scrapées      : ${sessionStats.pagesScraped}`,
      `  🔍 Annonces trouvées    : ${sessionStats.adsFound}`,
      `  ✅ Annonces conservées  : ${sessionStats.adsKept}`,
      `  🔄 Doublons fusionnés   : ${sessionStats.adsDuplicates}`,
      `  📝 Descriptions extraites: ${sessionStats.descriptionsExtracted}`,
      `  🛑 Pages bloquées (403) : ${sessionStats.descriptionsBlocked}`,
      `  🧠 IA Analyse — OK      : ${sessionStats.aiAnalyzed}`,
      `  🧠 IA Analyse — fallback: ${sessionStats.aiFallback}`,
      `  🧠 IA Analyse — erreurs: ${sessionStats.aiErrors}`,
      `  📊 IA Marché — OK       : ${sessionStats.marketAnalyzed}`,
      `  📊 IA Marché — fallback : ${sessionStats.marketFallback}`,
      `  ❌ Erreurs              : ${sessionStats.errors}`,
      `  ⚠️  Avertissements      : ${sessionStats.warnings}`,
      `  🐛 Logs debug           : ${sessionStats.debugs}`,
      sessionStats.stoppedEarly ? '  ⚠️  Terminé en avance (interruption IP/CAPTCHA)' : '  ✅ Terminé normalement',
      '═══════════════════════════════════════════════════════════',
    ];
    for (const line of lines) {
      sendLog({ level: 'info', message: line });
    }
  }

  ipcMain.on('job:start', async (event, config) => {
    if (isRunning) {
      sendLog({ level: 'warn', message: '[job:start] Un job est déjà en cours — requête ignorée.' });
      return;
    }
    isRunning = true;
    sessionStats = newSessionStats();
    sessionStats.t0 = Date.now();
    sessionStats.pagesRequested = parseInt(config.pages, 10) || 1;

    const { searchUrl, pages = 1, noDesc = false, autoAiMarket = true, analyzeImages = false, limit, aiConfig, proxyUrl } = config;
    // Note : analyzeImages est conservé pour rétro-compatibilité UI mais n'a plus
    // d'effet séparé — l'IA Analyse (adAnalyzer) combine déjà texte + vision en
    // un seul appel quand des photos sont disponibles et qu'un modèle vision est configuré.
    const userSettings = loadSettings();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jobDir = path.join(JOBS_DIR, `job-${timestamp}`);
    const harPath = path.join(jobDir, 'capture.har');
    const resultsDir = path.join(jobDir, 'results');

    sendLog({ level: 'debug', message: `[job:start] Config reçue — searchUrl=${searchUrl} | pages=${pages} | noDesc=${noDesc}  autoAiMarket=${autoAiMarket} | analyzeImages=${analyzeImages} | limit=${limit ?? '(aucun)'} | proxy=${proxyUrl || 'aucun'} | aiConfig.provider=${aiConfig?.provider || '?'} | aiConfig.apiKey=${redact(aiConfig?.apiKey)}` });
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
        // Met à jour pagesScraped pour le résumé de session (la dernière page
        // réussie atteinte pendant la capture HAR).
        if (typeof currentPage === 'number' && currentPage > sessionStats.pagesScraped) {
          sessionStats.pagesScraped = currentPage;
        }
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
        // Comptage pour le résumé de session
        const level = data.level || 'info';
        if (level === 'error') sessionStats.errors++;
        else if (level === 'warn') sessionStats.warnings++;
        else if (level === 'debug') sessionStats.debugs++;
        // Extraction des métriques depuis les logs du pipeline
        const msg = data.message || '';
        // 🟢 FIX : Détection d'interruption élargie (prend en compte "interrompu" et "restreint")
        if (msg.includes('interrompu') || msg.includes('restreint')) {
          stoppedEarly = true;
          sessionStats.stoppedEarly = true;
        }
        // Compter les annonces extraites
        const adsMatch = msg.match(/(\d+)\s+annonce\(s\)\s+(?:unique|extrait)/i);
        if (adsMatch) sessionStats.adsFound = Math.max(sessionStats.adsFound, parseInt(adsMatch[1], 10));
        // Compter les doublons fusionnés
        const dupMatch = msg.match(/(\d+)\s+doublon/i);
        if (dupMatch) sessionStats.adsDuplicates += parseInt(dupMatch[1], 10);
        // Compter les descriptions extraites (✅ [X/Y])
        const descMatch = msg.match(/✅\s*\[(\d+)\/\d+\]/);
        if (descMatch) sessionStats.descriptionsExtracted = Math.max(sessionStats.descriptionsExtracted, parseInt(descMatch[1], 10));
        // Compter les blocages 403
        if (msg.includes('Bloqué (HTTP 403') || msg.includes('BLOCKED_403')) sessionStats.descriptionsBlocked++;
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
        limit: limit ? parseInt(limit, 10) : undefined,
        speed: userSettings.scrapeSpeed || 'fast',
        headless: userSettings.headless !== false,
      });
      sendLog({ level: 'debug', message: `[job:start] Phase pipeline terminée en ${Math.round((Date.now() - t0Pipeline) / 1000)}s.` });

      activeRunner = null;

      const jsonPath = path.join(resultsDir, 'annonces.json');
      const xlsxPath = path.join(resultsDir, 'annonces.xlsx');

      if (fs.existsSync(jsonPath)) {
        // Lecture via checksum : le pipeline écrit annonces.json avec
        // writeWithChecksum. readWithChecksum valide l'intégrité (SHA-256) et
        // donne un message clair si le fichier est corrompu (crash pendant
        // l'écriture, disque défaillant) au lieu d'un JSON.parse qui throw
        // silencieusement et fait tomber le job en erreur générique.
        const { data: ads, valid, reason } = readWithChecksum(jsonPath);
        if (!valid || !Array.isArray(ads)) {
          sendLog({ level: 'warn', message: `[job:start] annonces.json illisible (${reason || 'format inattendu'}) — étapes suivantes (IA/Excel) ignorées pour ce job.` });
          sessionStats.warnings++;
        } else {
        let adsWithAi = ads;
        sessionStats.adsKept = ads.length;
        if (sessionStats.adsFound === 0) sessionStats.adsFound = ads.length;
        sendLog({ level: 'debug', message: `[job:start] annonces.json lu : ${summarizeAds(adsWithAi)}.` });

        // 🧠 IA ANALYSE (Texte + Vision) — uniquement si « Analyse IA » cochée.
        // L'IA Analyse reconstitue ce qu'est réellement l'objet vendu en croisant
        // titre + description + données scraper + photos. Pas de score ni de
        // scam score : juste un résumé précis + les attributs clés (modèle, état,
        // défauts, accessoires…). Résultat stocké dans ad.adAnalysis.
        if (autoAiMarket) {
          // 🩺 Health-check Ollama avant l'analyse (si provider ollama)
          if (aiConfig?.provider === 'ollama' || !aiConfig?.provider) {
            const { checkModelAvailable } = require('../services/ai/ollamaHealth');
            const ollamaUrl = aiConfig.ollamaUrl || 'http://127.0.0.1:11434';
            const modelName = aiConfig.visionModel || aiConfig.model || 'llava';
            sendLog({ level: 'debug', message: `[IA] Health-check Ollama (${ollamaUrl}, modèle ${modelName})...` });
            const health = await checkModelAvailable(ollamaUrl, modelName);
            if (!health.ok) {
              sendLog({ level: 'warn', message: `🩺 ${health.message} — l'analyse IA va échouer pour chaque annonce (fallback automatique appliqué).` });
            } else {
              sendLog({ level: 'debug', message: `🩺 ${health.message}` });
            }
          }

          sendStatus({ state: 'processing', message: 'Analyse IA des annonces (texte + vision)...' });
          const visionModel = aiConfig?.visionModel || 'llava';
          sendLog({ level: 'info', message: `🧠 Lancement de l'IA Analyse (${ads.length} annonces, texte + ${analyzeImages ? 'vision activée' : 'vision si photos'}, parallèle x${userSettings.aiConcurrency || 4}, modèle ${visionModel})...` });

          const t0Ai = Date.now();
          const analysisConfig = {
            provider: aiConfig?.provider || 'ollama',
            ...(aiConfig?.ollamaUrl ? { ollamaUrl: aiConfig.ollamaUrl } : {}),
            ...(aiConfig?.model ? { textModel: aiConfig.model } : {}),
            ...(visionModel ? { visionModel } : {}),
          };
          adsWithAi = await AdAnalyzer.analyzeAds(adsWithAi, analysisConfig, {
            concurrency: userSettings.aiConcurrency || 4,
            onProgress: (prog) => sendProgress({
              percent: 75 + Math.round((prog.percent / 100) * 25),
              status: prog.status,
            }),
            onLog: (data) => { sendLog(data); if (data.level === 'error') sessionStats.aiErrors++; },
          });
          const aiElapsed = Math.round((Date.now() - t0Ai) / 1000);
          const analyzedCount = adsWithAi.filter((a) => a.adAnalysis && !a.adAnalysis._fallback).length;
          sessionStats.aiAnalyzed = analyzedCount;
          sessionStats.aiFallback = adsWithAi.length - analyzedCount;
          sendLog({ level: 'info', message: `✅ IA Analyse terminée en ${aiElapsed}s (${analyzedCount}/${adsWithAi.length} annonces analysées, ${adsWithAi.length - analyzedCount} fallback).` });
          sendLog({ level: 'debug', message: `[job:start] Phase IA Analyse terminée en ${aiElapsed}s.` });

          writeWithChecksum(jsonPath, adsWithAi, null, 2);
          writeSummaryFile(adsWithAi, path.join(path.dirname(jsonPath), 'resumes-ia.json'));
        } else {
          sendLog({ level: 'debug', message: '[job:start] IA Analyse ignorée (autoAiMarket=false).' });
        }

        await ExcelExporter.exportToXlsx(adsWithAi, xlsxPath);
        sendLog({ level: 'info', message: '📊 Export Excel (.xlsx) généré avec succès !' });

        // Note : la notification « Très bonne affaire » dépendait de l'ancien
        // scoring marketAnalysis.classification. L'IA Marché est désormais une
        // action manuelle (bouton « Analyse IA » dans l'Explorateur) qui produit
        // le verdict en € — la notification sera déclenchée depuis ce flux manuel.
        const analyzed = adsWithAi.filter((a) => a.adAnalysis && !a.adAnalysis._fallback).length;
        if (analyzed > 0) {
          sendLog({ level: 'debug', message: `[job:start] ${analyzed} annonce(s) analysée(s) par l'IA (résumés produits + attributs).` });
        }
        } // fin du else (annonces.json lisible)
      } else {
        sendLog({ level: 'warn', message: `[job:start] annonces.json introuvable après pipeline : ${jsonPath} — le scraping a peut-être échoué silencieusement.` });
      }

      const latestJob = JobHistoryManager.getLatestJob();
      sendLog({ level: 'debug', message: `[job:start] Durée totale du job : ${Math.round((Date.now() - t0Total) / 1000)}s | stoppedEarly=${stoppedEarly}.` });

      // ─── Résumé de session ───
      sendSessionSummary();

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
      sessionStats.errors++;
      sendSessionSummary();
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
    if (activeCapturer) activeCapturer.stop(); // Arrêt immédiat de la capture HAR en cours
  });

  // 🌐 IA MARCHÉ — recherche Internet + estimation réelle de la valeur.
  // Bouton « Analyse IA » dans l'Explorateur. Reçoit les annonces (avec
  // adAnalysis déjà produit par l'IA 1) et estime la valeur réelle de chaque
  // produit via recherche web (SearchProvider sans-clé par défaut) + synthèse IA.
  // Résultat stocké dans ad.marketAnalysis : { realValue, verdict, deltaEur, sources[], rationale }.
  ipcMain.handle('market:analyze', async (event, { jobId, aiConfig, searchConfig, adIds }) => {
    if (isRunning) throw new Error('Un job de scraping est en cours — attendez la fin avant d\'analyser le marché.');
    if (isMarketAnalyzing) throw new Error('Une analyse de marché est déjà en cours — attendez la fin avant d\'en lancer une autre.');
    isMarketAnalyzing = true;
    try {
    const jobs = JobHistoryManager.listAllJobs();
    const targetJob = jobs.find((j) => j.id === jobId);

    if (!targetJob) throw new Error(`Job introuvable (id: ${jobId}). Aucune analyse possible.`);
    if (!targetJob.files.json) throw new Error('Aucun fichier de résultats trouvé pour ce job.');

    // Lecture via checksum : valide l'intégrité (le fichier a pu être réécrit par
    // un job:start ou une précédente analyse marché) et donne un message clair
    // en cas de corruption au lieu d'un JSON.parse qui ferait échouer toute l'analyse.
    const { data: adsRead, valid: adsValid, reason: adsReason } = readWithChecksum(targetJob.files.json);
    if (!adsValid || !Array.isArray(adsRead)) {
      throw new Error(`annonces.json illisible pour ce job (${adsReason || 'format inattendu'}).`);
    }
    let ads = adsRead;

    // Filtrer aux annonces sélectionnées si adIds fourni (analyse ciblée).
    let targetAds = ads;
    if (Array.isArray(adIds) && adIds.length > 0) {
      const idSet = new Set(adIds);
      targetAds = ads.filter((a) => idSet.has(a.id));
      sendLog({ level: 'info', message: `[IA Marché] Analyse ciblée sur ${targetAds.length}/${ads.length} annonce(s).` });
    }

    const missing = targetAds.filter((a) => !a.adAnalysis);
    if (missing.length > 0) {
      sendLog({ level: 'warn', message: `[IA Marché] ${missing.length} annonce(s) sans adAnalysis (IA 1 manquante) — elles seront ignorées.` });
      targetAds = targetAds.filter((a) => a.adAnalysis);
    }

    const reanalyzeSettings = loadSettings();
    const marketAiConfig = {
      provider: aiConfig?.provider || 'ollama',
      ...(aiConfig?.ollamaUrl ? { ollamaUrl: aiConfig.ollamaUrl } : {}),
      ...(aiConfig?.model ? { textModel: aiConfig.model } : {}),
    };
    const sConfig = {
      provider: (searchConfig && searchConfig.provider) || 'duckduckgo',
      ...(searchConfig && searchConfig.apiKey ? { apiKey: searchConfig.apiKey } : {}),
      ...(searchConfig && searchConfig.timeoutMs ? { timeoutMs: searchConfig.timeoutMs } : {}),
    };

    sendStatus({ state: 'processing', message: 'Analyse de marché (recherche Internet + estimation)...' });
    sendLog({ level: 'info', message: `🌐 Lancement IA Marché (${targetAds.length} annonces, moteur ${sConfig.provider}, parallèle x${reanalyzeSettings.aiConcurrency || 3})...` });

    // 🩺 Health-checks préalables : Ollama (IA synthèse) + moteur de recherche.
    // Sans Ollama, toutes les annonces tombent en fallback instantané — on le
    // détecte AVANT pour donner un message clair au lieu d'un "0/N réussi" muet.
    if (marketAiConfig.provider === 'ollama' || !marketAiConfig.provider) {
      const { checkModelAvailable } = require('../services/ai/ollamaHealth');
      const ollamaUrl = marketAiConfig.ollamaUrl || 'http://127.0.0.1:11434';
      const modelName = marketAiConfig.textModel || 'llama3';
      sendLog({ level: 'debug', message: `[IA Marché] Health-check Ollama (${ollamaUrl}, modèle ${modelName})...` });
      const health = await checkModelAvailable(ollamaUrl, modelName);
      if (!health.ok) {
        sendLog({ level: 'warn', message: `🩺 ${health.message} — l'estimation de valeur va échouer pour chaque annonce.` });
      } else {
        sendLog({ level: 'debug', message: `🩺 ${health.message}` });
      }
    }
    try {
      const { getSearchProvider } = require('../services/ai/search/searchProviderRegistry');
      const engine = getSearchProvider(sConfig);
      const sh = await engine.checkHealth();
      if (!sh.ok) sendLog({ level: 'warn', message: `🔍 Moteur de recherche : ${sh.message}` });
      else sendLog({ level: 'debug', message: `🔍 Moteur de recherche : ${sh.message}` });
    } catch (err) {
      sendLog({ level: 'warn', message: `🔍 Moteur de recherche injoignable : ${err.message}` });
    }

    const t0 = Date.now();
    let searchOk = 0;
    let aiOk = 0;
    targetAds = await MarketValueAnalyzer.analyzeMarketBatch(targetAds, marketAiConfig, sConfig, {
      concurrency: reanalyzeSettings.aiConcurrency || 3,
      onProgress: (prog) => {
        sendProgress({ percent: prog.percent, status: prog.status });
        if (prog.stageCounts) { searchOk = prog.stageCounts.searchOk || searchOk; aiOk = prog.stageCounts.aiOk || aiOk; }
      },
      onLog: (data) => { sendLog(data); if (data.level === 'warn' && /fallback/.test(data.message || '')) sessionStats.marketFallback++; },
    });
    sessionStats.marketAnalyzed = targetAds.filter((a) => a.marketAnalysis && !a.marketAnalysis._fallback).length;
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const estimated = targetAds.filter((a) => a.marketAnalysis && !a.marketAnalysis._fallback).length;
    // Diagnostic détaillé : répartition des causes d'échec.
    const failReasons = {};
    for (const a of targetAds) {
      const ma = a.marketAnalysis;
      if (!ma || ma._fallback) {
        const reason = (ma && ma._error) || 'inconnu';
        // Catégorisation grossière pour un message lisible
        const cat = /moteur de recherche/i.test(reason) ? 'moteur de recherche (DDG)'
          : /IA indisponible/i.test(reason) ? 'IA (Ollama down)'
          : /JSON/i.test(reason) ? 'réponse IA non interprétable'
          : reason;
        failReasons[cat] = (failReasons[cat] || 0) + 1;
      }
    }
    if (estimated < targetAds.length) {
      const breakdown = Object.entries(failReasons).map(([k, v]) => `${v}× ${k}`).join(', ');
      sendLog({ level: 'warn', message: `⚠️ IA Marché terminée en ${elapsed}s — ${estimated}/${targetAds.length} réussies. Échecs : ${breakdown || 'inconnu'}.` });
    } else {
      sendLog({ level: 'info', message: `✅ IA Marché terminée en ${elapsed}s (${estimated}/${targetAds.length} estimations réussies).` });
    }

    writeWithChecksum(targetJob.files.json, ads, null, 2);
    writeSummaryFile(ads, path.join(path.dirname(targetJob.files.json), 'resumes-ia.json'));
    if (targetJob.files.xlsx) {
      await ExcelExporter.exportToXlsx(ads, targetJob.files.xlsx);
    }

    // Notification si une « Très bonne affaire » est détectée.
    const greatDeals = targetAds.filter((a) => a.marketAnalysis && a.marketAnalysis.verdictLabel === 'Très bonne affaire');
    if (greatDeals.length > 0) {
      sendLog({ level: 'info', message: `[IA Marché] ${greatDeals.length} « Très bonne affaire » détectée(s).` });
      Notifier.notifyGoodDeal(greatDeals[0]);
    }

    return JobHistoryManager.getLatestJob();
    } finally {
      // Toujours libérer le verrou, même en cas d'erreur fatale : sinon une
      // analyse échouée bloquait définitivement toute analyse de marché future.
      isMarketAnalyzing = false;
    }
  });

  // 🔍 Liste les moteurs de recherche disponibles (pour l'UI de l'IA Marché).
  ipcMain.handle('search:providers', async () => {
    return { providers: listSearchProviders() };
  });

  ipcMain.handle('config:get', async () => {
    return loadSettings();
  });

  // ℹ️ Diagnostic applicatif (non sensible) pour le formulaire de feedback.
  // Renvoie version, plateforme, arch et date — rien de personnel.
  ipcMain.handle('app:getDiagnostics', async () => {
    const os = require('os');
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      platform: os.platform(),
      arch: process.arch,
      osRelease: os.release(),
      locale: app.getLocale(),
      timestamp: new Date().toISOString(),
    };
  });

  // ─── Bibliothèque de prompts préfaits (IA Studio V2) ──────────────────
  // Remplace l'ancien générateur IA par des templates statiques à trous.
  // Aucune IA, aucun serveur : assemblage instantané.
  ipcMain.handle('prompt:templates:list', async () => {
    try {
      return { templates: listTemplates() };
    } catch (err) {
      return { templates: [], error: err.message };
    }
  });

  ipcMain.handle('prompt:templates:build', async (event, { templateId, values }) => {
    try {
      const result = buildPrompt(templateId, values || {});
      if (result.error) return { prompt: '', error: result.error };
      return { prompt: result.prompt };
    } catch (err) {
      return { prompt: '', error: err.message };
    }
  });

  // ─── Prompts IA internes (adAnalyzer + marketValueAnalyzer) ──────────
  // Expose les prompts réellement utilisés par les IA pendant le scraping,
  // pour que l'utilisateur puisse les voir, les comprendre et les copier.
  ipcMain.handle('prompt:internal:list', async () => {
    try {
      const { _getSystemPrompt: adSystem, _buildPrompt: adBuild } = require('../services/ai/adAnalyzer');
      const { _getSystemPrompt: marketSystem, _buildPrompt: marketBuild } = require('../services/ai/marketValueAnalyzer');

      // Prompt adAnalyzer avec une annonce fictive pour montrer le format
      const sampleAd = {
        id: 'EXEMPLE', title: 'Carte graphique RTX 3060', price: 250,
        description: 'RTX 3060 12GB, très bon état, fonctionne parfaitement. Vendue avec boîte d\'origine.',
        category: 'Informatique', seller: 'Jean', isPro: false, city: 'Paris', zipcode: '75001',
        images: ['https://example.com/img1.jpg', 'https://example.com/img2.jpg'],
      };
      const adPrompt = adBuild(sampleAd);

      // Prompt marketValueAnalyzer avec une annonce + sources fictives
      const sampleMarketAd = {
        id: 'EXEMPLE', price: 250, title: 'RTX 3060',
        adAnalysis: { identifiedProduct: 'NVIDIA RTX 3060 12GB', attributes: { brand: 'NVIDIA', model: 'RTX 3060', condition: 'très bon état', defects: [], working: 'normal' } },
      };
      const sampleResults = [
        { source: 'ebay', title: 'RTX 3060 12GB occasion', snippet: 'Prix moyen: 280-320€', url: 'https://ebay.fr/rtx3060' },
        { source: 'amazon', title: 'RTX 3060 neuf', snippet: 'Neuf: 350€', url: 'https://amazon.fr/rtx3060' },
      ];
      const marketPrompt = marketBuild(sampleMarketAd, sampleResults);

      return {
        prompts: [
          {
            id: 'ia-analyse',
            title: '🧠 IA Analyse (adAnalyzer)',
            category: 'Prompts IA internes',
            description: 'Prompt envoyé à l\'IA (Ollama) pendant le scraping pour analyser chaque annonce (texte + vision). Ce prompt est généré dynamiquement pour chaque annonce avec ses données réelles.',
            template: `${adSystem()}\n\n--- EXEMPLE AVEC UNE ANNONCE FICTIVE ---\n${adPrompt}`,
          },
          {
            id: 'ia-marche',
            title: '📊 IA Marché (marketValueAnalyzer)',
            category: 'Prompts IA internes',
            description: 'Prompt envoyé à l\'IA (Ollama) pour estimer la valeur réelle d\'un produit à partir des sources Internet trouvées. Ce prompt est généré dynamiquement avec les résultats de recherche réels.',
            template: `${marketSystem()}\n\n--- EXEMPLE AVEC UNE ANNONCE + SOURCES FICTIVES ---\n${marketPrompt}`,
          },
        ],
      };
    } catch (err) {
      return { prompts: [], error: err.message };
    }
  });

  // Génération de prompt personnalisé via Ollama LOCAL (module AI Studio).
  // Aucune IA sur le web, aucune clé API : tout passe par le serveur Ollama
  // local. L'utilisateur peut aussi vérifier qu'Ollama est démarré et lister
  // les modèles installés.
  ipcMain.handle('prompt:generate', async (event, { domain, objective, customHints, vars, ollamaUrl, ollamaModel, priceRange, topN, rankings }) => {
    const url = ollamaUrl || 'http://127.0.0.1:11434';
    const model = ollamaModel || 'llama3';
    sendStatus({ state: 'processing', message: `Génération du prompt par l'IA (${model})…` });

    // Health-check Ollama : vérifier serveur + modèle, éviter une attente de 180s.
    const health = await checkModelAvailable(url, model);
    if (!health.ok || health.available === false) {
      const isModelMissing = health.ok === true || (health.models && health.models.length > 0 && health.available === false);
      const msg = isModelMissing
        ? `Ollama n'a pas le modèle « ${model} » installé. Modèles disponibles : ${health.models.join(', ') || '(aucun)'}. Lancez « ollama pull ${model} ».`
        : `Ollama est injoignable sur ${url}. ${health.message} Démarrez Ollama (ollama serve).`;
      sendLog({ level: 'warn', message: `⚠️ ${msg}` });
      sendStatus({ state: 'error', message: msg });
      return { prompt: null, error: msg };
    }

    try {
      const prompt = await PromptGenerator.generate(
        { domain, objective, customHints, vars, ollamaUrl: url, textModel: model, priceRange, topN, rankings },
        (prog) => sendProgress({ percent: prog.percent, status: prog.status })
      );
      return { prompt };
    } catch (err) {
      const msg = `Échec génération prompt : ${err.message}`;
      sendLog({ level: 'error', message: `❌ ${msg}` });
      sendStatus({ state: 'error', message: msg });
      return { prompt: null, error: msg };
    }
  });

  // Liste les modèles Ollama installés localement (pour le select du module
  // AI Studio). Réutilise le health-check existant.
  ipcMain.handle('ollama:models', async (event, { ollamaUrl } = {}) => {
    const url = ollamaUrl || 'http://127.0.0.1:11434';
    try {
      const health = await checkOllamaHealth(url, 5000);
      return { ok: health.ok, message: health.message, models: health.models || [] };
    } catch (err) {
      return { ok: false, message: 'Ollama injoignable : ' + (err.message || err), models: [] };
    }
  });

  ipcMain.handle('config:save', async (event, patch) => {
    return saveSettings(patch);
  });

  // 🩺 Health-check Ollama (appelable depuis le renderer pour afficher le statut)
  ipcMain.handle('ollama:health', async (event, { ollamaUrl, model } = {}) => {
    const { checkModelAvailable } = require('../services/ai/ollamaHealth');
    const url = ollamaUrl || 'http://127.0.0.1:11434';
    const modelName = model || 'llama3';
    return await checkModelAvailable(url, modelName);
  });

  // 🔐 Secrets chiffrés (clés API stockées via safeStorage, pas en clair)
  ipcMain.handle('secret:get', async (event, key) => {
    const { SecretStore } = require('../utils/secretStore');
    return SecretStore.get(key);
  });
  ipcMain.handle('secret:set', async (event, { key, value }) => {
    const { SecretStore } = require('../utils/secretStore');
    SecretStore.set(key, value);
    return true;
  });
  ipcMain.handle('secret:has', async (event, key) => {
    const { SecretStore } = require('../utils/secretStore');
    return SecretStore.get(key) != null;
  });
  ipcMain.handle('secret:remove', async (event, key) => {
    const { SecretStore } = require('../utils/secretStore');
    SecretStore.remove(key);
    return true;
  });

  // 🌐 Test de connectivité réseau (pour le mode hors-ligne)
  ipcMain.handle('network:check', async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch('https://www.leboncoin.fr', {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'manual',
      });
      clearTimeout(timer);
      return { online: true, status: res.status };
    } catch {
      return { online: false };
    }
  });

  ipcMain.handle('job:getHistory', async () => {
    return JobHistoryManager.listAllJobs();
  });

  ipcMain.handle('job:delete', async (event, jobId) => {
    return JobHistoryManager.deleteJob(jobId);
  });

  // Validation de chemin : n'autorise que les chemins dans BASE_OUT_DIR ou ses
  // sous-dossiers (anti path-traversal depuis un renderer compromis).
  function isPathAllowed(target) {
    if (!target || typeof target !== 'string') return false;
    const resolved = path.resolve(target);
    const baseResolved = path.resolve(BASE_OUT_DIR);
    return resolved === baseResolved || resolved.startsWith(baseResolved + path.sep);
  }

  ipcMain.handle('file:openFolder', async (event, folderPath) => {
    try {
      const target = folderPath || BASE_OUT_DIR;
      if (!isPathAllowed(target)) return { success: false, error: 'Chemin non autorisé.' };
      FileManager.openFolder(target);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Handler dédié pour ouvrir le dossier des jobs (JOBS_DIR). Le bouton
  // "Ouvrir les jobs" de l'IA Studio passait null/'' → ouvrait BASE_OUT_DIR
  // (le parent) au lieu de JOBS_DIR. Ce handler ouvre directement le bon
  // dossier et le crée s'il n'existe pas.
  ipcMain.handle('jobs:openFolder', async () => {
    try {
      FileManager.openFolder(JOBS_DIR);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('file:openFile', async (event, filePath) => {
    try {
      if (!isPathAllowed(filePath)) return { success: false, error: 'Chemin non autorisé.' };
      FileManager.openFile(filePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('shell:openExternal', async (event, url) => {
    try {
      if (!url) return { success: false, error: 'URL vide' };
      let parsed;
      try { parsed = new URL(url); } catch { return { success: false, error: 'URL invalide' }; }
      // N'autorise que http/https (bloque file://, javascript:, data:, etc.)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { success: false, error: `Schéma non autorisé : ${parsed.protocol}` };
      }
      await shell.openExternal(url);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  return { shutdown };
}

module.exports = { setupIpcHandlers };