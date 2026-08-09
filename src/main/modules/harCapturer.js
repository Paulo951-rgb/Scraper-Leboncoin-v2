'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { chromium } = require('playwright');
const { sleep } = require('../utils/helpers');
const { GLOBAL_SESSION_PATH } = require('../config/constants');
const { formatBytes, formatMs, describeError } = require('../utils/diagnostics');

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

const STEALTH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

class HarCapturer extends EventEmitter {
  constructor(options = {}) {
    super();
    // Par défaut invisible. La bascule visible/invisible est gérée en interne
    // lors du pré-check captcha (voir _warmupSession).
    this.headless = options.headless !== undefined ? options.headless : true;
    this.proxyUrl = options.proxyUrl || null;
    this.minPageDelayMs = options.minPageDelayMs || 2500;
    this.maxPageDelayMs = options.maxPageDelayMs || 4500;
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
      userAgent: STEALTH_UA,
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
    await p.goto(checkUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch((e) => {
      this.emit('log', { level: 'warn', message: `Pré-check : navigation initiale impossible (${e.message}).` });
      this.emit('log', { level: 'debug', message: `[warmup] Détail erreur goto : ${describeError(e)}` });
    });
    this.emit('log', { level: 'debug', message: `[warmup] Navigation pré-check terminée en ${formatMs(Date.now() - t0Goto)}.` });
    await sleep(1500);

    const blocked = await this._checkCaptcha(p);
    await p.close().catch(() => {});
    await ctx.close().catch(() => {});

    if (!blocked) {
      // Pas de captcha : on persiste quand même la session fraîche si elle n'existait pas.
      if (!fs.existsSync(GLOBAL_SESSION_PATH)) {
        await ctx.storageState({ path: GLOBAL_SESSION_PATH }).catch((e) => {
          this.emit('log', { level: 'warn', message: `[warmup] Sauvegarde session fraîche impossible : ${e.message}` });
        });
        this.emit('log', { level: 'debug', message: `[warmup] Session fraîche persistée : ${GLOBAL_SESSION_PATH}` });
      }
      this.emit('log', { level: 'info', message: '✅ Pré-check OK : aucun CAPTCHA, reprise invisible.' });
      return;
    }

    // CAPTCHA détecté : ouverture d'une fenêtre VISIBLE pour résolution humaine.
    this.emit('log', { level: 'warn', message: '⚠️ CAPTCHA détecté — affichage de la fenêtre (résolution humaine requise).' });
    this.emit('progress', { currentPage: 0, totalPages: 0, percent: 0, status: 'CAPTCHA : veuillez valider dans la fenêtre ouverte...' });

    // Relance un navigateur visible (le navigateur headless actuel ne peut pas
    // devenir visible à chaud) afin que l'utilisateur puisse interagir.
    const visibleBrowser = await chromium.launch(this._launchOptions(false));
    try {
      const vOpts = this._baseContextOptions();
      if (fs.existsSync(GLOBAL_SESSION_PATH)) vOpts.storageState = GLOBAL_SESSION_PATH;
      const { ctx: vCtx, p: vPage } = await this._newStealthContext(visibleBrowser, vOpts);
      await vPage.goto(checkUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
        this.emit('log', { level: 'warn', message: `[warmup] Navigation fenêtre visible échouée : ${e.message}` });
      });

      let isBlocked = await this._checkCaptcha(vPage);
      let waitAttempts = 0;
      while (isBlocked && !this.isCancelled) {
        waitAttempts++;
        if (waitAttempts % 5 === 0) {
          this.emit('log', { level: 'debug', message: `[warmup] En attente de résolution CAPTCHA... (${waitAttempts * 2}s écoulées)` });
        }
        await sleep(2000);
        isBlocked = await this._checkCaptcha(vPage);
      }
      if (this.isCancelled) {
        this.emit('log', { level: 'warn', message: '[warmup] Résolution CAPTCHA annulée par lutilisateur.' });
      } else {
        this.emit('log', { level: 'debug', message: `[warmup] CAPTCHA résolu après ${waitAttempts * 2}s d'attente.` });
      }

      // Persiste la session validée pour les jobs suivants (plus de fenêtre visible).
      await vCtx.storageState({ path: GLOBAL_SESSION_PATH });
      this.emit('log', { level: 'debug', message: `[warmup] Session validée persistée : ${GLOBAL_SESSION_PATH} (${formatBytes(fs.statSync(GLOBAL_SESSION_PATH).size)})` });
      await vPage.close().catch(() => {});
      await vCtx.close().catch(() => {});
      this.emit('log', { level: 'info', message: '✅ CAPTCHA résolu — reprise invisible.' });
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

          // 🤖 DÉTECTION DE CAPTCHA / BLOCAGE (filet de sécurité après pré-check)
          let isBlocked = await this._checkCaptcha(page);
          if (isBlocked) {
            this.emit('log', { level: 'warn', message: `⚠️ [Page ${pageNum}] BLOCAGE RÉSIDUEL DÉTECTÉ en invisible. Arrêt de la capture (relancez après validation).` });
            this.emit('log', { level: 'debug', message: `[capture] Arrêt à la page ${pageNum}/${maxPages} — captcha non résolu malgré le pré-check.` });
            break;
          }
        } catch (gotoErr) {
          this.emit('log', { level: 'warn', message: `[Page ${pageNum}] Avertissement : ${gotoErr.message}` });
          this.emit('log', { level: 'debug', message: `[capture] Détail erreur page ${pageNum} : ${describeError(gotoErr)}` });
        }

        if (pageNum < maxPages) {
          await sleep(this.minPageDelayMs + Math.random() * 1000);
        }
      }

      this.emit('log', { level: 'info', message: 'Finalisation et sauvegarde de la session...' });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

      // Sauvegarder les cookies validés dans la session globale et locale
      await context.storageState({ path: GLOBAL_SESSION_PATH });
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