'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { chromium } = require('playwright');
const { sleep } = require('../../utils/helpers');
const { GLOBAL_SESSION_PATH } = require('../../config/constants');
const { formatBytes, formatMs, describeError } = require('../../utils/diagnostics');

const BLOCK_MARKERS = ['captcha', 'vitesse surhumaine', 'robot', 'restreint', 'captcha-delivery'];

function buildPageUrl(baseUrl, pageNumber) {
  try {
    const urlObj = new URL(baseUrl);
    urlObj.searchParams.set('page', String(pageNumber));
    return urlObj.toString();
  } catch (err) {
    throw new Error(`URL invalide : "${baseUrl}" (${err.message})`);
  }
}

const { getRandomUserAgent } = require('./userAgents');

class HarCapturer extends EventEmitter {
  constructor(options = {}) {
    super();
    // Par défaut invisible. La bascule visible/invisible est gérée en interne
    // lors du pré-check captcha (voir _warmupSession).
    this.headless = options.headless !== undefined ? options.headless : true;
    this.proxyUrl = options.proxyUrl || null;
    this.minPageDelayMs = options.minPageDelayMs || 800;
    this.maxPageDelayMs = options.maxPageDelayMs || 1500;
    this.isCancelled = false;
  }

  stop() {
    this.isCancelled = true;
  }

  _launchOptions(headless) {
    const opts = { headless };
    if (this.proxyUrl) opts.proxy = { server: this.proxyUrl };
    return opts;
  }

  _baseContextOptions(extras = {}) {
    return {
      userAgent: getRandomUserAgent(),
      locale: 'fr-FR',
      viewport: { width: 1366, height: 850 },
      ...extras,
    };
  }

  async _newStealthContext(browser, contextOptions) {
    const ctx = await browser.newContext(contextOptions);
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const p = await ctx.newPage();
    return { ctx, p };
  }

  // Détecte un CAPTCHA / blocage sur la page (réutilise BLOCK_MARKERS).
  // Retourne { blocked, matchedMarker } pour permettre un diagnostic précis.
  async _checkCaptcha(page) {
    try {
      const visibleText = await page.evaluate(() => {
        return (document.title + ' ' + document.body.innerText).toLowerCase();
      });
      const matchedMarker = BLOCK_MARKERS.find((marker) => visibleText.includes(marker));
      if (matchedMarker) {
        this.emit('log', { level: 'debug', message: `[captcha] Marqueur détecté : "${matchedMarker}" dans le texte de la page.` });
      }
      return !!matchedMarker;
    } catch (e) {
      this.emit('log', { level: 'debug', message: `[captcha] Évaluation du contenu impossible : ${e.message} — considéré comme non bloqué.` });
      return false;
    }
  }

  // Pré-check Leboncoin : navigue en invisible, et si un CAPTCHA est détecté,
  // bascule dans une fenêtre VISIBLE pour résolution humaine, puis revient en
  // invisible. La session validée est persistée dans GLOBAL_SESSION_PATH.
  async _warmupSession(browser, checkUrl) {
    this.emit('log', { level: 'info', message: '🔍 Pré-check session : navigation invisible vers Leboncoin...' });
    this.emit('log', { level: 'debug', message: `[warmup] URL de vérification : ${checkUrl} | session existante : ${fs.existsSync(GLOBAL_SESSION_PATH) ? 'OUI (' + formatBytes(fs.statSync(GLOBAL_SESSION_PATH).size) + ')' : 'NON'}` });

    const ctxOpts = this._baseContextOptions();
    if (fs.existsSync(GLOBAL_SESSION_PATH)) {
      ctxOpts.storageState = GLOBAL_SESSION_PATH;
      this.emit('log', { level: 'info', message: '🔑 Chargement de la session globale (Master Session)...' });
    }

    const { ctx, p } = await this._newStealthContext(browser, ctxOpts);
    const t0Goto = Date.now();
    let warmupStatus = null;
    await p.goto(checkUrl, { waitUntil: 'domcontentloaded', timeout: 35000 })
      .then((resp) => { warmupStatus = resp ? resp.status() : null; })
      .catch((e) => {
        this.emit('log', { level: 'warn', message: `Pré-check : navigation initiale impossible (${e.message}).` });
        this.emit('log', { level: 'debug', message: `[warmup] Détail erreur goto : ${describeError(e)}` });
      });
    this.emit('log', { level: 'debug', message: `[warmup] Navigation pré-check terminée en ${formatMs(Date.now() - t0Goto)}${warmupStatus ? ` — HTTP ${warmupStatus}` : ''}.` });
    await sleep(1500);

    // Un blocage peut se manifester par un CAPTCHA (texte détectable) OU par un
    // code HTTP d'erreur (403/429). On vérifie les deux pour ne pas rater un
    // blocage "silencieux" (403 sans page CAPTCHA).
    const captchaBlocked = await this._checkCaptcha(p);
    const httpBlocked = typeof warmupStatus === 'number' && warmupStatus >= 400;
    const blocked = captchaBlocked || httpBlocked;

    if (httpBlocked && !captchaBlocked) {
      this.emit('log', { level: 'warn', message: `[warmup] HTTP ${warmupStatus} détecté (blocage anti-bot sans CAPTCHA visible) — ouverture navigateur visible pour résolution manuelle.` });
    }

    if (!blocked) {
      // Pas de captcha : on persiste la session fraîche si elle n'existait pas,
      // AVANT de fermer le contexte (storageState sur un contexte fermé échoue).
      if (!fs.existsSync(GLOBAL_SESSION_PATH)) {
        await ctx.storageState({ path: GLOBAL_SESSION_PATH }).catch((e) => {
          this.emit('log', { level: 'warn', message: `[warmup] Sauvegarde session fraîche impossible : ${e.message}` });
        });
        this.emit('log', { level: 'debug', message: `[warmup] Session fraîche persistée : ${GLOBAL_SESSION_PATH}` });
      }
      await p.close().catch(() => {});
      await ctx.close().catch(() => {});
      this.emit('log', { level: 'info', message: '✅ Pré-check OK : aucun CAPTCHA, reprise invisible.' });
      return;
    }

    // Blocage détecté (CAPTCHA ou HTTP 403/429) : ferme le contexte invisible
    // avant d'ouvrir une fenêtre VISIBLE pour résolution humaine.
    await p.close().catch(() => {});
    await ctx.close().catch(() => {});

    this.emit('log', { level: 'warn', message: '⚠️ Blocage détecté — affichage de la fenêtre (résolution humaine requise).' });
    this.emit('progress', { currentPage: 0, totalPages: 0, percent: 0, status: 'Blocage : veuillez résoudre dans la fenêtre ouverte...' });

    // Relance un navigateur visible (le navigateur headless actuel ne peut pas
    // devenir visible à chaud) afin que l'utilisateur puisse interagir.
    const visibleBrowser = await chromium.launch(this._launchOptions(false));
    try {
      const vOpts = this._baseContextOptions();
      if (fs.existsSync(GLOBAL_SESSION_PATH)) vOpts.storageState = GLOBAL_SESSION_PATH;
      const { ctx: vCtx, p: vPage } = await this._newStealthContext(visibleBrowser, vOpts);
      let vStatus = null;
      await vPage.goto(checkUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
        .then((resp) => { vStatus = resp ? resp.status() : null; })
        .catch((e) => {
          this.emit('log', { level: 'warn', message: `[warmup] Navigation fenêtre visible échouée : ${e.message}` });
        });

      // Vérifie le blocage : CAPTCHA (texte) OU HTTP >= 400.
      const checkVBlocked = async () => {
        const captcha = await this._checkCaptcha(vPage);
        const http = typeof vStatus === 'number' && vStatus >= 400;
        return captcha || http;
      };

      let isBlocked = await checkVBlocked();
      let waitAttempts = 0;
      while (isBlocked && !this.isCancelled) {
        waitAttempts++;
        if (waitAttempts % 5 === 0) {
          this.emit('log', { level: 'debug', message: `[warmup] En attente de résolution... (${waitAttempts * 2}s écoulées)` });
        }
        await sleep(2000);
        // Re-vérifie : l'utilisateur a peut-être résolu le CAPTCHA ou le blocage IP a expiré.
        try {
          const resp = await vPage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
          vStatus = resp ? resp.status() : vStatus;
        } catch { /* ignore reload errors, keep waiting */ }
        isBlocked = await checkVBlocked();
      }
      if (this.isCancelled) {
        this.emit('log', { level: 'warn', message: '[warmup] Résolution annulée par lutilisateur.' });
        // NE PAS persister la session : on est encore bloqué (CAPTCHA non résolu),
        // persister reviendrait à sauvegarder une session avec des cookies anti-bot
        // qui empoisonneraient tous les jobs suivants. On ferme sans storageState.
        await vPage.close().catch(() => {});
        await vCtx.close().catch(() => {});
        return;
      }
      this.emit('log', { level: 'debug', message: `[warmup] Blocage résolu après ${waitAttempts * 2}s d'attente.` });

      // Persiste la session validée pour les jobs suivants (plus de fenêtre visible).
      await vCtx.storageState({ path: GLOBAL_SESSION_PATH });
      this.emit('log', { level: 'debug', message: `[warmup] Session validée persistée : ${GLOBAL_SESSION_PATH} (${formatBytes(fs.statSync(GLOBAL_SESSION_PATH).size)})` });
      await vPage.close().catch(() => {});
      await vCtx.close().catch(() => {});
      this.emit('log', { level: 'info', message: '✅ Blocage résolu — reprise invisible.' });
    } finally {
      await visibleBrowser.close().catch(() => {});
    }
  }

  async capture({ searchUrl, maxPages = 1, outputHarPath }) {
    if (!searchUrl) throw new Error("L'URL de recherche est requise.");
    const targetDir = path.dirname(outputHarPath);
    fs.mkdirSync(targetDir, { recursive: true });
    const statePath = path.join(targetDir, 'session-state.json');

    this.emit('log', { level: 'info', message: `🚀 Initialisation de la capture HAR (${maxPages} page(s))...` });
    this.emit('log', { level: 'debug', message: `[capture] searchUrl=${searchUrl} | maxPages=${maxPages} | outputHarPath=${outputHarPath} | proxy=${this.proxyUrl || 'aucun'} | headless=${this.headless}` });

    let browser;
    let context;
    let page;

    try {
      browser = await chromium.launch(this._launchOptions(true));
      this.emit('log', { level: 'debug', message: '[capture] Chromium lancé (headless=true pour la capture).' });

      let globalSessionSaved = false;

      // Pré-check captcha + bascule visible si nécessaire (avant la boucle HAR).
      await this._warmupSession(browser, buildPageUrl(searchUrl, 1));
      if (this.isCancelled) {
        this.emit('log', { level: 'debug', message: '[capture] Capture annulée après pré-check (isCancelled=true).' });
        await browser.close().catch(() => {});
        return outputHarPath;
      }

      const contextOptions = this._baseContextOptions({
        recordHar: {
          path: outputHarPath,
          mode: 'full',
          urlFilter: /recherche|api|items/i,
        },
      });

      if (fs.existsSync(GLOBAL_SESSION_PATH)) {
        contextOptions.storageState = GLOBAL_SESSION_PATH;
        this.emit('log', { level: 'info', message: '🔑 Session validée chargée pour la capture.' });
      } else {
        this.emit('log', { level: 'warn', message: '[capture] Aucune session globale trouvée pour la capture — risque de blocage captcha plus élevé.' });
      }

      ({ ctx: context, p: page } = await this._newStealthContext(browser, contextOptions));
      this.emit('log', { level: 'debug', message: '[capture] Contexte HAR créé (filtrage URL: recherche|api|items).' });

      for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        if (this.isCancelled) {
          this.emit('log', { level: 'debug', message: `[capture] Boucle de capture interrompue à la page ${pageNum} (annulation).` });
          break;
        }

        // Recyclage toutes les 3 pages pour la RAM
        if (pageNum > 1 && pageNum % 3 === 0) {
          this.emit('log', { level: 'debug', message: '🔄 Purge mémoire Chromium...' });
          await page.close().catch(() => {});
          await sleep(500);
          page = await context.newPage();
        }

        const targetUrl = buildPageUrl(searchUrl, pageNum);
        this.emit('progress', { currentPage: pageNum, totalPages: maxPages, percent: Math.round((pageNum / maxPages) * 100), status: `Navigation page ${pageNum}/${maxPages}...` });
        this.emit('log', { level: 'info', message: `[Page ${pageNum}/${maxPages}] Navigation vers ${targetUrl}` });

        try {
          const resp = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
          const httpStatus = resp ? resp.status() : '?';
          this.emit('log', { level: 'debug', message: `[Page ${pageNum}] Page chargée — HTTP ${httpStatus}.` });

          // Sauvegarde la session globale dès la 1ère page réussie (HTTP < 400).
          // On NE la réécrit PAS ensuite : les pages suivantes peuvent être 403
          // (anti-bot) et empoisonneraient la session avec des cookies de blocage.
          if (typeof httpStatus === 'number' && httpStatus < 400 && !globalSessionSaved) {
            await context.storageState({ path: GLOBAL_SESSION_PATH }).catch((e) => {
              this.emit('log', { level: 'warn', message: `[capture] Sauvegarde session globale impossible après page ${pageNum} : ${e.message}` });
            });
            globalSessionSaved = true;
            this.emit('log', { level: 'debug', message: `[capture] Session globale sauvegardée après page ${pageNum} (HTTP ${httpStatus}).` });
          }

          // 🤖 DÉTECTION DE BLOCAGE : CAPTCHA (texte) OU HTTP >= 400 (anti-bot).
          // Un 403 sans texte CAPTCHA est un blocage silencieux : on arrête
          // immédiatement au lieu de gaspiller des requêtes sur les pages suivantes.
          const captchaBlocked = await this._checkCaptcha(page);
          const httpBlocked = typeof httpStatus === 'number' && httpStatus >= 400;
          if (captchaBlocked || httpBlocked) {
            const reason = httpBlocked ? `HTTP ${httpStatus}` : 'CAPTCHA';
            this.emit('log', { level: 'warn', message: `⚠️ [Page ${pageNum}] BLOCAGE DÉTECTÉ (${reason}) — arrêt de la capture. Relancez après résolution dans le navigateur visible.` });
            this.emit('log', { level: 'debug', message: `[capture] Arrêt à la page ${pageNum}/${maxPages} — blocage ${reason} malgré le pré-check.` });
            break;
          }
        } catch (gotoErr) {
          this.emit('log', { level: 'warn', message: `[Page ${pageNum}] Avertissement : ${gotoErr.message}` });
          this.emit('log', { level: 'debug', message: `[capture] Détail erreur page ${pageNum} : ${describeError(gotoErr)}` });
        }

        if (pageNum < maxPages) {
          const minDelay = this.minPageDelayMs;
          const maxDelay = Math.max(this.maxPageDelayMs, minDelay);
          await sleep(minDelay + Math.random() * (maxDelay - minDelay));
        }
      }

      this.emit('log', { level: 'info', message: 'Finalisation et sauvegarde de la session...' });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

      // Session locale (par-job) : toujours sauvegardée pour le pipeline d'enrichissement.
      // La session globale (GLOBAL_SESSION_PATH) a déjà été sauvegardée après la 1ère page
      // réussie ci-dessus — on ne l'écrase PAS ici pour éviter de la corrompre avec d'éventuels
      // cookies anti-bot accumulés sur les pages suivantes (403).
      await context.storageState({ path: statePath });

      await context.close();
      await browser.close();
      browser = null;
      this.emit('log', { level: 'info', message: `✅ Session synchronisée.` });

      // Diagnostic final : taille du HAR généré
      if (fs.existsSync(outputHarPath)) {
        const harSize = fs.statSync(outputHarPath).size;
        this.emit('log', { level: 'debug', message: `[capture] HAR généré : ${outputHarPath} (${formatBytes(harSize)}).` });
      } else {
        this.emit('log', { level: 'warn', message: `[capture] ⚠️ Le fichier HAR n'a pas été créé : ${outputHarPath}` });
      }

      return outputHarPath;
    } catch (err) {
      this.emit('log', { level: 'error', message: `❌ Erreur : ${err.message}` });
      this.emit('log', { level: 'debug', message: `[capture] Détail erreur fatale : ${describeError(err)}` });
      throw err;
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
}

module.exports = { HarCapturer };