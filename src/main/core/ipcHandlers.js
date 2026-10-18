'use strict';

const path = require('path');
const fs = require('fs');
const { ipcMain, shell, app } = require('electron');
const { HarCapturer } = require('../services/scraping/harCapturer');
const { PipelineRunner } = require('../services/scraping/pipelineRunner');
const { FileManager } = require('../infrastructure/fileManager');
const { JobHistoryManager } = require('../services/jobs/jobHistory');
const { StorageCleaner } = require('../services/maintenance/storageCleaner');
const { JOBS_DIR, BASE_OUT_DIR } = require('../config/constants');
const { getScrapingPolicy } = require('../config/scraping');
const { summarizeAds, formatBytes, describeError } = require('../utils/diagnostics');
const { readWithChecksum } = require('../utils/integrity');
const { loadSettings, saveSettings } = require('./settings');
const { getProfileFields } = require('../services/exporting/dataProfiles');

function setupIpcHandlers(getMainWindow) {
  let activeCapturer = null;
  let activeRunner = null;
  let isRunning = false;

  // Token d'annulation partagé pour les tâches longues (scraping). Le bouton
  // « Arrêter » positionne activeCancel.cancelled = true ; la capture HAR et le
  // pipeline forké s'arrêtent proprement.
  let activeCancel = null;

  // Identifiant de corrélation du job courant : attaché à chaque log/statut pour
  // permettre de filtrer/regrouper les lignes d'un même run (utile quand
  // plusieurs sessions se succèdent dans la même console).
  let currentJobId = null;

  // Niveau de log minimal transmis au renderer (configurable). Le pipeline
  // continue de tout émettre ; on filtre au niveau du pont IPC pour éviter de
  // saturer la console avec des logs debug en production.
  const LOG_LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40 };
  let currentLogLevel = 'debug';
  const isLogVisible = (level) => (LOG_LEVEL_RANK[level] || 20) >= (LOG_LEVEL_RANK[currentLogLevel] || 10);

  // Getter de fenêtre principale : renvoie null si détruite/fermée,
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
      if (activeCancel) activeCancel.cancelled = true;
    } catch { /* shutdown best-effort */ }
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
  currentLogLevel = settings.logLevel || 'debug';

  setTimeout(() => {
    StorageCleaner.cleanOldHars(settings.autoCleanHarDays || 7);
    if (settings.autoCleanJobsDays && settings.autoCleanJobsDays > 0) {
      const purged = StorageCleaner.cleanOldJobs(settings.autoCleanJobsDays);
      if (purged > 0) logger.info(`[startup] ${purged} job(s) ancien(s) supprimé(s) (>${settings.autoCleanJobsDays}j).`);
    }
  }, 3000);

  const sendLog = (data) => {
    if (!isLogVisible(data.level || 'info')) return;
    const w = getWin(); if (w) w.webContents.send('log', currentJobId ? { ...data, jobId: currentJobId } : data);
  };
  const sendProgress = (data) => { const w = getWin(); if (w) w.webContents.send('progress', data); };
  const sendStatus = (status) => { const w = getWin(); if (w) w.webContents.send('status', currentJobId ? { ...status, jobId: currentJobId } : status); };

  // ─── Suivi de session pour le résumé de fin de scraping ────────────────────
  // Les compteurs sont incrémentés au fil du job (via l'écoute des logs du
  // pipeline). À la fin, un résumé formaté est envoyé.
  function newSessionStats() {
    return {
      t0: 0, pagesRequested: 0, pagesScraped: 0,
      adsFound: 0, adsKept: 0, adsDuplicates: 0,
      descriptionsExtracted: 0, descriptionsBlocked: 0,
      errors: 0, warnings: 0, debugs: 0,
      stoppedEarly: false,
      // Blocage d'accès détecté pendant l'enrichissement (403/429) : permet de
      // rapporter un « succès partiel » honnête plutôt qu'un succès complet.
      accessBlocked: false, accessCode: null,
    };
  }
  let sessionStats = newSessionStats();

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
      `  🔍 Annonces extraites   : ${sessionStats.adsFound} (uniques)`,
      `  ✅ Annonces conservées  : ${sessionStats.adsKept}`,
      `  🔄 Doublons fusionnés   : ${sessionStats.adsDuplicates}`,
      `  📝 Descriptions extraites: ${sessionStats.descriptionsExtracted}`,
      `  🛑 Blocages d'accès     : ${sessionStats.descriptionsBlocked} (HTTP 403/429)`,
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
    // Validation AVANT d'armer le verrou : une configuration absente/malformée
    // ne doit pas positionner le verrou hors du bloc `try/finally`. Sinon
    // l'exception (ex. `config` undefined → lecture de `config.pages`) laissait
    // le verrou armé pour toujours : tous les jobs suivants étaient
    // silencieusement ignorés jusqu'au redémarrage de l'application.
    if (!config || typeof config !== 'object') {
      sendLog({ level: 'error', message: '[job:start] Configuration de scraping absente ou invalide — job refusé.' });
      return;
    }
    const { searchUrl, pages = 1, limit, profileId, exportFields } = config;
    if (typeof searchUrl !== 'string' || searchUrl.trim() === '') {
      sendLog({ level: 'error', message: '[job:start] URL de recherche absente — job refusé.' });
      return;
    }
    isRunning = true;
    // Nouveau token d'annulation pour ce job (bouton « Arrêter »). Réinitialisé
    // à chaque job : un clic Arrêter n'affecte QUE le job en cours.
    activeCancel = { cancelled: false };
    sessionStats = newSessionStats();
    sessionStats.t0 = Date.now();
    sessionStats.pagesRequested = parseInt(pages, 10) || 1;

    // Les descriptions sont toujours enrichies : l'option « Ignorer les
    // descriptions » a été retirée de l'interface. Le pipeline reçoit donc
    // toujours noDesc=false (comportement normal du produit).
    const noDesc = false;
    // Le proxy rotatif a été retiré de l'interface : aucune configuration proxy
    // n'est transmise. Les mécanismes de backoff/circuit breaker restent actifs.
    // Résolution du profil de données (Défaut / Maximum / Personnalisé) en une
    // liste concrète de clés de champs. Le pipeline reçoit `profileFields` qu'il
    // applique aux exports JSON et TXT.
    const resolvedProfileId = (profileId === 'maximum' || profileId === 'custom') ? profileId : 'default';
    const profileFields = getProfileFields(resolvedProfileId, exportFields);
    if (resolvedProfileId === 'custom' && (!profileFields || profileFields.length === 0)) {
      // Mode custom demandé mais aucun champ valide fourni : getProfileFields a
      // déjà appliqué un fallback sur les champs essentiels. On log un
      // avertissement pour aider l'utilisateur à comprendre ce qu'il a choisi.
      sendLog({ level: 'warn', message: '[job:start] Profil Personnalisé actif mais aucun champ valide sélectionné — fallback sur les champs essentiels.' });
    }
    const userSettings = loadSettings();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jobDir = path.join(JOBS_DIR, `job-${timestamp}`);
    const harPath = path.join(jobDir, 'capture.har');
    const resultsDir = path.join(jobDir, 'results');
    currentJobId = `job-${timestamp}`;

    sendLog({ level: 'debug', message: `[job:start] Config reçue — searchUrl=${searchUrl} | pages=${pages} | limit=${limit ?? '(aucun)'}` });
    sendLog({ level: 'debug', message: `[job:start] Dossiers — jobDir=${jobDir} | harPath=${harPath} | resultsDir=${resultsDir}` });

    let stoppedEarly = false;

    try {
      sendStatus({ state: 'capturing', message: 'Capture HAR automatique en cours...' });
      sendLog({ level: 'info', message: '--- DÉMARRAGE DU SCRAPING ---' });
      const t0Total = Date.now();

      // Politique de scraping FIXE (config/scraping.js) : concurrence 25 max,
      // délai nominal 400 ms entre pages. Non modifiable par l'utilisateur.
      const policy = getScrapingPolicy();
      const pageDelay = policy.pageDelayMs;
      activeCapturer = new HarCapturer({
        headless: userSettings.headless !== false,
        minPageDelayMs: pageDelay,
        maxPageDelayMs: pageDelay,
      });
      sendLog({ level: 'debug', message: `[job:start] Mode=${policy.label} | concurrence=${policy.concurrency} | délai pages=${pageDelay}ms | headless=${userSettings.headless !== false}` });

      activeCapturer.on('log', sendLog);
      activeCapturer.on('progress', ({ currentPage, totalPages, percent, status }) => {
        sendProgress({ percent: Math.round(percent * 0.25), status: `[HAR] ${status}` });
        // Met à jour pagesScraped pour le résumé de session (la dernière page
        // réussie atteinte pendant la capture HAR).
        if (typeof currentPage === 'number' && currentPage > sessionStats.pagesScraped) {
          sessionStats.pagesScraped = currentPage;
        }
      });

      // UA figé pour toute la capture : capturé AVANT capture() et avant de
      // mettre activeCapturer à null, pour le transmettre au pipeline
      // (enrichissement) et garder une empreinte cohérente (mêmes cookies + UA).
      const captureUserAgent = activeCapturer.getUserAgent();

      await activeCapturer.capture({
        searchUrl,
        maxPages: Math.min(500, Math.max(1, parseInt(pages, 10) || 1)),
        outputHarPath: harPath,
      });
      const harElapsed = Date.now() - t0Total;
      sendLog({ level: 'debug', message: `[job:start] Phase capture HAR terminée en ${Math.round(harElapsed / 1000)}s. Taille HAR : ${fs.existsSync(harPath) ? formatBytes(fs.statSync(harPath).size) : '(introuvable)'}.` });

      activeCapturer = null;

      // Si l'utilisateur a demandé l'arrêt pendant la capture HAR, on NE lance
      // PAS le pipeline d'enrichissement (coûteux) et on remonte un état
      // « annulé » distinct — sinon un clic « Arrêter » aboutissait à un
      // message « Scraping terminé avec succès ! » trompeur.
      if (activeCancel && activeCancel.cancelled) {
        throw Object.assign(new Error('Scraping annulé par l\'utilisateur.'), { _cancelled: true });
      }

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
        // Signal d'arrêt STRUCTURÉ (machine-lisible) émis par le pipeline :
        //   « [STOP_REASON] code=HTTP_403 status=403 reason=access_refused consecutiveBlocks=3 »
        // Remplace les heuristiques de texte fragiles ("interrompu"/"restreint")
        // qui pouvaient déclencher un faux « succès partiel » sur un simple
        // message de détection CAPTCHA (le mot "restreint" apparaît dans les
        // marqueurs de détection, pas forcément dans une vraie restriction).
        const stopMatch = msg.match(/\[STOP_REASON\]\s+code=(\S+)\s+status=(\S*)\s+reason=(\S+)/);
        if (stopMatch) {
          stoppedEarly = true;
          sessionStats.stoppedEarly = true;
          sessionStats.accessBlocked = true;
          sessionStats.accessCode = /429/.test(stopMatch[1]) ? 'HTTP_RATE_LIMITED' : 'HTTP_ACCESS_REFUSED';
        }
        // Compter les annonces extraites. Le pipeline émet :
        //   « Étape HAR -> Annonces terminée : N annonces extraites. » (info)
        //   « [mergeDuplicates] M annonce(s) en entrée | … | N unique(s) en sortie. » (debug)
        // L'ancien motif exigeait « annonce(s) unique|extrait ». Il ne matchait
        // PAS « N annonces extraites » (mot au singulier alors que le nombre peut
        // être pluriel) → adsFound restait à 0 dans le résumé alors que la capture
        // avait bien extrait N annonces (contradiction « 236 extraites / 0 trouvée »).
        const extractMatch = msg.match(/(\d+)\s+annonces?\s+extraites?/i);
        if (extractMatch) sessionStats.adsFound = Math.max(sessionStats.adsFound, parseInt(extractMatch[1], 10));
        const uniqueMatch = msg.match(/(\d+)\s+unique\(s\)\s+en\s+sortie/i);
        if (uniqueMatch) sessionStats.adsFound = Math.max(sessionStats.adsFound, parseInt(uniqueMatch[1], 10));
        // Compat : ancien format « N annonce(s) unique(s) ».
        const adsMatch = msg.match(/(\d+)\s+annonce\(s\)\s+(?:unique|extrait)/i);
        if (adsMatch) sessionStats.adsFound = Math.max(sessionStats.adsFound, parseInt(adsMatch[1], 10));
        // Compter les doublons fusionnés. Deux formats possibles :
        //   « N doublon(s) fusionné(s) » (pipeline)  |  « N doublon » (générique)
        const dupMatch = msg.match(/(\d+)\s+doublon/i);
        if (dupMatch) sessionStats.adsDuplicates = Math.max(sessionStats.adsDuplicates, parseInt(dupMatch[1], 10));
        // Compter les descriptions extraites (✅ [X/Y])
        const descMatch = msg.match(/✅\s*\[(\d+)\/\d+\]/);
        if (descMatch) sessionStats.descriptionsExtracted = Math.max(sessionStats.descriptionsExtracted, parseInt(descMatch[1], 10));
        // Compter les blocages d'accès (403/429) — formats actuels et historiques.
        if (msg.includes('Accès refusé (HTTP 403)') || msg.includes('Bloqué (HTTP 403') || msg.includes('BLOCKED_403')) sessionStats.descriptionsBlocked++;
        else if (msg.includes('Requête limitée (HTTP 429)') || msg.includes('BLOCKED_429')) sessionStats.descriptionsBlocked++;
        // Blocage d'accès structuré remonté par l'enrichissement (403/429/arrêt
        // préventif) → succès partiel honnête.
        if (msg.includes('[HTTP_ACCESS_REFUSED]') || msg.includes('[HTTP_429]') || msg.includes('[HTTP_RATE_LIMITED]')) {
          sessionStats.accessBlocked = true;
          sessionStats.accessCode = msg.includes('[HTTP_RATE_LIMITED]') || msg.includes('[HTTP_429]') ? 'HTTP_RATE_LIMITED' : 'HTTP_ACCESS_REFUSED';
        }
        if (msg.includes('Blocage détecté. Arrêt préventif')) sessionStats.accessBlocked = true;
      });

      activeRunner.on('progress', ({ percent, status, eta }) => {
        const globalPercent = 25 + Math.round((percent / 100) * 50);
        sendProgress({ percent: globalPercent, status, eta });
      });

      const t0Pipeline = Date.now();
      const pipelineExit = await activeRunner.run({
        harPath,
        outDir: resultsDir,
        noDesc,
        fresh: true,
        limit: limit ? parseInt(limit, 10) : undefined,
        speed: policy.mode,
        headless: userSettings.headless !== false,
        userAgent: captureUserAgent,
        // BASE_OUT_DIR : le pipeline forké n'a pas accès à electron → on lui
        // transmet le chemin pour qu'il localise la session globale.
        baseOutDir: BASE_OUT_DIR,
        // Profil de données (Défaut / Maximum / Personnalisé) : liste concrète de
        // clés de champs à exporter, appliquée par le pipeline (JSON + TXT).
        profileId: resolvedProfileId,
        profileFields,
        includeSellerData: userSettings.includeSellerData !== false,
      });
      sendLog({ level: 'debug', message: `[job:start] Phase pipeline terminée en ${Math.round((Date.now() - t0Pipeline) / 1000)}s.` });

      activeRunner = null;

      // Le runner renvoie 130 si le pipeline forké a été interrompu (SIGINT).
      // Sans ce test, une annulation PENDANT l'enrichissement était rapportée
      // comme un succès. Les résultats partiels restent sur disque (écritures
      // atomiques + checkpoints), on se contente de corriger l'état final.
      if (pipelineExit === 130) {
        throw Object.assign(new Error('Scraping annulé par l\'utilisateur.'), { _cancelled: true });
      }

      const jsonPath = path.join(resultsDir, 'annonces.json');
      // Annonces retenues pour l'ingestion dans la base historique. Renseigné
      // UNIQUEMENT si annonces.json est lisible et valide : une collecte
      // corrompue ne doit jamais alimenter l'historique.
      let adsToIngest = null;

      if (fs.existsSync(jsonPath)) {
        // Lecture via checksum : le pipeline écrit annonces.json avec
        // writeWithChecksum. readWithChecksum valide l'intégrité (SHA-256) et
        // donne un message clair si le fichier est corrompu (crash pendant
        // l'écriture, disque défaillant) au lieu d'un JSON.parse qui throw
        // silencieusement et fait tomber le job en erreur générique.
        const { data: ads, valid, reason } = readWithChecksum(jsonPath);
        if (!valid || !Array.isArray(ads)) {
          sendLog({ level: 'warn', message: `[job:start] annonces.json illisible (${reason || 'format inattendu'}) — étapes suivantes ignorées pour ce job.` });
          sessionStats.warnings++;
        } else {
          sessionStats.adsKept = ads.length;
          if (sessionStats.adsFound === 0) sessionStats.adsFound = ads.length;
          sendLog({ level: 'debug', message: `[job:start] annonces.json lu : ${summarizeAds(ads)}.` });
          adsToIngest = ads;
        }
      } else {
        sendLog({ level: 'warn', message: `[job:start] annonces.json introuvable après pipeline : ${jsonPath} — le scraping a peut-être échoué silencieusement.` });
      }

      // ─── Alimentation de la base historique « Évolution des prix » ──────────
      // Après une collecte RÉUSSIE, les annonces admissibles alimentent la base
      // historique sans import manuel. Une erreur du moteur historique NE DOIT
      // PAS faire échouer la collecte : on capture et on journalise.
      if (adsToIngest && adsToIngest.length > 0) {
        try {
          const { getService } = require('../services/history/priceHistoryService');
          const histService = getService();
          const ingestResult = histService.ingest(adsToIngest, {
            sourceJob: currentJobId,
            observedAt: new Date().toISOString(),
          });
          if (ingestResult.ok) {
            const s = ingestResult.summary;
            sendLog({ level: 'info', message: `[historique] ${s.processed} annonce(s) ingérée(s) — ${s.linked} associée(s), ${s.pending} incertaine(s), ${s.rejected} exclue(s), ${s.pricesExcluded} prix écarté(s).` });
            if (s.errors > 0) sendLog({ level: 'warn', message: `[historique] ${s.errors} annonce(s) non traitée(s) par le moteur (isolées, sans impact sur le job).` });
          } else {
            sendLog({ level: 'warn', message: `[historique] ingestion ignorée : ${ingestResult.error}` });
          }
        } catch (histErr) {
          // Isolation stricte : l'historique est un enrichissement optionnel.
          sendLog({ level: 'warn', message: `[historique] moteur indisponible (${histErr.message}) — le scraping reste valide.` });
        }
      }

      const latestJob = JobHistoryManager.getLatestJob();
      sendLog({ level: 'debug', message: `[job:start] Durée totale du job : ${Math.round((Date.now() - t0Total) / 1000)}s | stoppedEarly=${stoppedEarly} | accessBlocked=${sessionStats.accessBlocked}.` });

      // ─── Résumé de session ───
      sendSessionSummary();

      // Succès PARTIEL : soit les pages ont été interrompues (stop préventif), soit
      // l'enrichissement a été bloqué (403/429) alors que des annonces avaient
      // déjà été extraites. On ne déclare JAMAIS « succès » dans ces cas.
      const partial = stoppedEarly || sessionStats.accessBlocked;
      if (partial) {
        const reason = sessionStats.accessCode === 'HTTP_RATE_LIMITED'
          ? 'Requête limitée (HTTP 429) pendant l\'enrichissement'
          : sessionStats.accessCode === 'HTTP_ACCESS_REFUSED'
            ? 'Accès refusé (HTTP 403) pendant l\'enrichissement'
            : 'Interruption préventive anti-bot';
        sendProgress({ percent: 100, status: 'Sauvegardé (succès partiel)' });
        sendStatus({
          state: 'partial',
          message: `Succès partiel : ${sessionStats.adsKept} annonce(s) conservée(s). ${reason} — certaines descriptions manquent. L'export reste disponible.`,
          latestJob,
        });
      } else {
        sendProgress({ percent: 100, status: 'Terminé à 100 % !' });
        sendStatus({
          state: 'completed',
          message: `Scraping terminé avec succès ! ${sessionStats.adsKept} annonce(s).`,
          latestJob,
        });
      }

    } catch (err) {
      if (err && err._cancelled) {
        // Annulation utilisateur : état dédié (« cancelled »), distinct d'un
        // succès et d'une erreur. Le renderer réactive les boutons.
        sendLog({ level: 'warn', message: `⏹️ ${err.message}` });
        sendSessionSummary();
        sendStatus({ state: 'cancelled', message: 'Scraping annulé par l\'utilisateur.' });
      } else {
        sendLog({ level: 'error', message: `❌ Erreur : ${err.message}` });
        sendLog({ level: 'debug', message: `[job:start] Détail erreur fatale : ${describeError(err)}` });
        sessionStats.errors++;
        // Résultats partiels : le pipeline écrit annonces.json AVANT la phase
        // d'enrichissement. Si l'échec survient après (ex. enrichissement bloqué),
        // les annonces déjà extraites restent valides — on les signale au lieu de
        // les perdre derrière une erreur générique.
        const partialJson = path.join(resultsDir, 'annonces.json');
        let partialAds = null;
        if (fs.existsSync(partialJson)) {
          const r = readWithChecksum(partialJson);
          if (r.valid && Array.isArray(r.data) && r.data.length > 0) partialAds = r.data.length;
        }
        sendSessionSummary();
        if (partialAds != null) {
          sessionStats.adsKept = partialAds;
          sendLog({ level: 'warn', message: `[job:start] ${partialAds} annonce(s) déjà extraite(s) conservée(s) malgré l'échec de l'enrichissement.` });
          sendStatus({ state: 'partial', message: `Succès partiel : ${partialAds} annonce(s) extraite(s) et conservée(s). ${err.message}`, latestJob: JobHistoryManager.getLatestJob() });
        } else {
          sendStatus({ state: 'error', message: `Erreur : ${err.message}` });
        }
      }
    } finally {
      isRunning = false;
      activeCapturer = null;
      activeRunner = null;
      activeCancel = null;
      currentJobId = null;
    }
  });

  // ⏹️ Bouton « Arrêter » : arrêt propre de la capture HAR et du pipeline forké.
  ipcMain.on('job:stop', () => {
    if (activeCancel) {
      activeCancel.cancelled = true;
      sendLog({ level: 'warn', message: '⏹️ Demande d\'arrêt envoyée — arrêt en cours de la tâche.' });
    }
    if (activeRunner) activeRunner.stop();
    if (activeCapturer) activeCapturer.stop(); // Arrêt immédiat de la capture HAR en cours
    if (!isRunning && !activeCancel) {
      sendLog({ level: 'debug', message: '[job:stop] Aucune tâche en cours.' });
    }
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

  // 🩺 Vérification du binaire Chromium (Playwright) : scraping-critique.
  // Si le binaire n'est pas installé, le scraping échoue avec une erreur
  // cryptique « Executable doesn't exist » au moment de chromium.launch().
  // On vérifie le chemin renvoyé par chromium.executablePath() sur le disque
  // et on renvoie un statut + un message d'aide (« npx playwright install
  // chromium ») pour que le renderer affiche un bandeau d'avertissement
  // AVANT que l'utilisateur ne lance un job qui échouera.
  ipcMain.handle('app:checkChromium', async () => {
    try {
      const { chromium } = require('playwright');
      const exePath = chromium.executablePath();
      const exists = fs.existsSync(exePath);
      const result = {
        ok: exists,
        path: exePath,
        exists,
        reason: exists ? null : 'Binaire Chromium introuvable sur le disque.',
        fixCommand: 'npx playwright install chromium',
      };
      if (!exists) {
        logger.warn(`[Chromium] Binaire manquant : ${exePath} — exécutez « npx playwright install chromium ».`);
      } else {
        logger.info(`[Chromium] Binaire OK : ${exePath}`);
      }
      return result;
    } catch (err) {
      logger.warn(`[Chromium] Vérification impossible : ${err.message}`);
      return { ok: false, path: null, exists: false, reason: err.message, fixCommand: 'npx playwright install chromium' };
    }
  });

  ipcMain.handle('config:save', async (event, patch) => {
    const merged = saveSettings(patch);
    if (merged && merged.logLevel) currentLogLevel = merged.logLevel;
    // Applique la rétention des logs immédiatement : sans cela, modifier
    // « Rétention des logs (jours) » dans les Paramètres n'avait d'effet qu'au
    // prochain démarrage (le logger gardait l'ancienne valeur en mémoire).
    if (merged && merged.logRetentionDays) logger.setRetention(merged.logRetentionDays);
    return merged;
  });

  // 💾 Export des logs de session vers un fichier texte (dans BASE_OUT_DIR/logs).
  // Le renderer envoie le texte déjà formaté ; le main choisit le chemin (jamais
  // fourni par le renderer) pour éviter toute écriture arbitraire.
  ipcMain.handle('logs:export', async (event, text) => {
    const safeText = typeof text === 'string' ? text : '';
    if (!safeText.trim()) return { ok: false, error: 'Aucun log à exporter.' };
    const logsDir = path.join(BASE_OUT_DIR, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(logsDir, `session-export-${ts}.log`);
    fs.writeFileSync(outPath, safeText, 'utf8');
    return { ok: true, path: outPath };
  });

  // 🔐 Secrets chiffrés (clés API stockées via safeStorage, pas en clair)
  // Liste blanche des clés : un renderer compromis (XSS) ne peut PAS exiger le
  // déchiffrement d'un secret arbitraire. La lecture d'une valeur en clair est
  // réservée aux clés effectivement consommées par l'UI. `secret:get` reste
  // sinon exposé et renverrait n'importe quelle valeur déchiffrée.
  const SECRET_GET_ALLOWLIST = new Set(['tavily-api-key', 'search-api-key']);
  const SECRET_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  const isAllowedSecretKey = (key) => typeof key === 'string' && SECRET_KEY_RE.test(key);
  ipcMain.handle('secret:get', async (event, key) => {
    if (!isAllowedSecretKey(key)) {
      sendLog({ level: 'warn', message: `[security] secret:get refusé (clé invalide) : ${String(key).slice(0, 40)}` });
      return null;
    }
    if (!SECRET_GET_ALLOWLIST.has(key)) {
      sendLog({ level: 'warn', message: `[security] secret:get refusé (clé hors liste blanche) : ${key}` });
      return null;
    }
    const { SecretStore } = require('../utils/secretStore');
    return SecretStore.get(key);
  });
  ipcMain.handle('secret:set', async (event, { key, value } = {}) => {
    if (!isAllowedSecretKey(key)) {
      sendLog({ level: 'warn', message: `[security] secret:set refusé (clé invalide) : ${String(key).slice(0, 40)}` });
      return false;
    }
    if (value != null && typeof value !== 'string') {
      sendLog({ level: 'warn', message: `[security] secret:set refusé (valeur non textuelle) : ${key}` });
      return false;
    }
    const { SecretStore } = require('../utils/secretStore');
    SecretStore.set(key, value);
    return true;
  });
  ipcMain.handle('secret:has', async (event, key) => {
    if (!isAllowedSecretKey(key)) return false;
    const { SecretStore } = require('../utils/secretStore');
    return SecretStore.get(key) != null;
  });
  ipcMain.handle('secret:remove', async (event, key) => {
    if (!isAllowedSecretKey(key)) {
      sendLog({ level: 'warn', message: `[security] secret:remove refusé (clé invalide) : ${String(key).slice(0, 40)}` });
      return false;
    }
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

  // Historique d'évolution des annonces (changements de prix / likes / statut
  // entre sessions). Permet de détecter les annonces dont le prix baisse d'un
  // scraping à l'autre.
  ipcMain.handle('job:getAdHistory', async () => {
    return JobHistoryManager.getAdHistory();
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
      const errStr = await FileManager.openFolder(target);
      // shell.openPath renvoie '' en cas de succès, ou un message d'erreur
      // (ex: "Failed to open ...") sans throw. Sans cette vérification, l'échec
      // était silencieux : le bouton paraissait ne « rien faire ».
      if (errStr) return { success: false, error: errStr };
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Handler dédié pour ouvrir le dossier des jobs (JOBS_DIR).
  ipcMain.handle('jobs:openFolder', async () => {
    try {
      const errStr = await FileManager.openFolder(JOBS_DIR);
      // shell.openPath renvoie '' si OK, sinon un message d'erreur. On remonte
      // l'échec pour que le renderer puisse l'afficher (sinon bouton silencieux).
      if (errStr) return { success: false, error: errStr };
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 📂 Ouvre le dossier de RÉSULTATS d'une session de scraping précise.
  // L'utilisateur doit retrouver directement les exports (JSON, TXT, rapport)
  // de la session — pas seulement un fichier ni le dossier parent global.
  // Sécurité : le chemin n'est PAS fourni par le renderer. On ne transmet qu'un
  // identifiant de job (validé au format job-<timestamp>), puis on reconstruit
  // et on vérifie le chemin côté main (anti path-traversal). Le dossier visé
  // est <JOBS_DIR>/<jobId>/results ; à défaut, le dossier du job.
  const JOB_ID_RE = /^job-[a-zA-Z0-9-]+$/;
  ipcMain.handle('job:openSessionFolder', async (event, jobId) => {
    try {
      if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId) || jobId.includes('..')) {
        return { success: false, error: 'Identifiant de session invalide.' };
      }
      const jobPath = path.join(JOBS_DIR, jobId);
      const resolved = path.resolve(jobPath);
      const baseResolved = path.resolve(JOBS_DIR);
      if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) {
        return { success: false, error: 'Chemin non autorisé.' };
      }
      if (!fs.existsSync(jobPath)) {
        return { success: false, error: 'Le dossier de cette session n\'existe plus (session supprimée ou déplacée).' };
      }
      const resultsDir = path.join(jobPath, 'results');
      const target = fs.existsSync(resultsDir) ? resultsDir : jobPath;
      const errStr = await FileManager.openFolder(target);
      if (errStr) return { success: false, error: errStr };
      return { success: true, path: target };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('file:openFile', async (event, filePath) => {
    try {
      if (!isPathAllowed(filePath)) return { success: false, error: 'Chemin non autorisé.' };
      const errStr = await FileManager.openFile(filePath);
      if (errStr) return { success: false, error: errStr };
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

  // ═══════════════════════════════════════════════════════════════════════════
  // 📈 ÉVOLUTION DES PRIX — handlers IPC
  // ═══════════════════════════════════════════════════════════════════════════
  // Le renderer ne reçoit JAMAIS d'accès direct à la base : il appelle ces
  // handlers, qui valident les entrées et délèguent à la façade. Aucune requête
  // SQL arbitraire n'est possible depuis le renderer (pas de canal générique).
  const { getService: getPriceHistoryService } = require('../services/history/priceHistoryService');

  // Normalise/valide les options de lecture venant du renderer (pagination,
  // filtres). Un renderer compromis ne peut donc pas demander un volume
  // arbitraire ni injecter de valeurs inattendues.
  function sanitizeHistoryOpts(raw) {
    const o = (raw && typeof raw === 'object') ? raw : {};
    const intInRange = (v, min, max, def) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n >= min && n <= max ? n : def;
    };
    const out = {
      limit: intInRange(o.limit, 1, 500, 50),
      offset: intInRange(o.offset, 0, 1_000_000, 0),
      granularity: ['day', 'week', 'month'].includes(o.granularity) ? o.granularity : 'day',
    };
    if (typeof o.q === 'string' && o.q.trim() !== '') out.q = o.q.trim().slice(0, 120);
    if (typeof o.family === 'string' && o.family.trim() !== '') out.family = o.family.trim().slice(0, 60);
    if (o.days != null) out.days = intInRange(o.days, 1, 3650, 30);
    return out;
  }

  ipcMain.handle('history:stats', async () => {
    try {
      const svc = getPriceHistoryService();
      if (!svc.isReady()) {
        return { ok: false, error: svc.lastError ? svc.lastError.message : 'Base historique indisponible.', counts: null };
      }
      return svc.stats();
    } catch (err) {
      return { ok: false, error: err.message, counts: null };
    }
  });

  // Amorçage : intègre les jobs DÉJÀ présents sur le disque (migration sûre,
  // sans relancer de collecte). Idempotent.
  ipcMain.handle('history:bootstrap', async () => {
    try {
      const svc = getPriceHistoryService();
      const res = svc.bootstrapFromExistingJobs();
      if (!res.ok) return res;
      sendLog({ level: 'info', message: `[historique] amorçage depuis ${res.jobs} session(s) : ${res.ads} annonce(s) traitée(s).` });
      return { ...res, ...svc.stats() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('history:listProducts', async (event, rawOpts) => {
    try {
      const svc = getPriceHistoryService();
      if (!svc.isReady()) return { ok: false, error: svc.lastError ? svc.lastError.message : 'Base historique indisponible.', products: [] };
      return svc.listProducts(sanitizeHistoryOpts(rawOpts));
    } catch (err) {
      return { ok: false, error: err.message, products: [] };
    }
  });

  ipcMain.handle('history:productDetail', async (event, productId, rawOpts) => {
    try {
      const id = parseInt(productId, 10);
      if (!Number.isFinite(id) || id <= 0) return { ok: false, error: 'Identifiant de produit invalide.' };
      const svc = getPriceHistoryService();
      if (!svc.isReady()) return { ok: false, error: svc.lastError ? svc.lastError.message : 'Base historique indisponible.' };
      return svc.getProductDetail(id, sanitizeHistoryOpts(rawOpts));
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('history:productSeries', async (event, productId, rawOpts) => {
    try {
      const id = parseInt(productId, 10);
      if (!Number.isFinite(id) || id <= 0) return { ok: false, error: 'Identifiant de produit invalide.' };
      const svc = getPriceHistoryService();
      if (!svc.isReady()) return { ok: false, error: svc.lastError ? svc.lastError.message : 'Base historique indisponible.' };
      return svc.getProductSeries(id, sanitizeHistoryOpts(rawOpts));
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('history:listPending', async (event, rawOpts) => {
    try {
      const svc = getPriceHistoryService();
      if (!svc.isReady()) return { ok: false, error: svc.lastError ? svc.lastError.message : 'Base historique indisponible.', pending: [] };
      return svc.listPending(sanitizeHistoryOpts(rawOpts));
    } catch (err) {
      return { ok: false, error: err.message, pending: [] };
    }
  });

  // Correction manuelle d'une association (persistée + recalcul des stats).
  const CORRECTION_ACTIONS = new Set(['confirm', 'reject', 'move', 'create']);
  ipcMain.handle('history:correct', async (event, payload) => {
    try {
      const p = (payload && typeof payload === 'object') ? payload : {};
      const adId = parseInt(p.adId, 10);
      if (!Number.isFinite(adId) || adId <= 0) return { ok: false, error: 'Identifiant d\'annonce invalide.' };
      const action = { type: p.action };
      if (!CORRECTION_ACTIONS.has(action.type)) return { ok: false, error: 'Action de correction inconnue.' };
      if (p.productId != null) {
        const pid = parseInt(p.productId, 10);
        if (!Number.isFinite(pid) || pid <= 0) return { ok: false, error: 'Identifiant de produit cible invalide.' };
        action.productId = pid;
      }
      const note = typeof p.note === 'string' ? p.note.slice(0, 500) : null;
      const svc = getPriceHistoryService();
      if (!svc.isReady()) return { ok: false, error: svc.lastError ? svc.lastError.message : 'Base historique indisponible.' };
      const res = svc.correct(adId, action, { note });
      if (res.ok) sendLog({ level: 'info', message: `[historique] association corrigée manuellement (annonce ${adId}, action ${action.type}).` });
      return res;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('history:recompute', async (event, productId) => {
    try {
      const svc = getPriceHistoryService();
      if (!svc.isReady()) return { ok: false, error: svc.lastError ? svc.lastError.message : 'Base historique indisponible.' };
      const id = productId == null ? null : parseInt(productId, 10);
      if (id != null && (!Number.isFinite(id) || id <= 0)) return { ok: false, error: 'Identifiant de produit invalide.' };
      return svc.recompute(id);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  return { shutdown };
}

module.exports = { setupIpcHandlers };
