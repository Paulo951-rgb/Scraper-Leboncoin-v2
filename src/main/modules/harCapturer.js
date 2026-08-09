'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { chromium } = require('playwright');
const { sleep } = require('../utils/helpers');
const { GLOBAL_SESSION_PATH } = require('../config/constants');

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

class HarCapturer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.headless = options.headless !== undefined ? options.headless : false;
    this.proxyUrl = options.proxyUrl || null;
    this.minPageDelayMs = options.minPageDelayMs || 2500;
    this.maxPageDelayMs = options.maxPageDelayMs || 4500;
    this.isCancelled = false;
  }

  stop() {
    this.isCancelled = true;
  }

  async capture({ searchUrl, maxPages = 1, outputHarPath }) {
    if (!searchUrl) throw new Error("L'URL de recherche est requise.");
    const targetDir = path.dirname(outputHarPath);
    fs.mkdirSync(targetDir, { recursive: true });
    const statePath = path.join(targetDir, 'session-state.json');

    this.emit('log', { level: 'info', message: `🚀 Initialisation de la capture HAR (${maxPages} page(s))...` });

    let browser;
    let context;
    let page;

    try {
      const launchOptions = { headless: this.headless };
      if (this.proxyUrl) launchOptions.proxy = { server: this.proxyUrl };

      browser = await chromium.launch(launchOptions);

      const contextOptions = {
        recordHar: {
          path: outputHarPath,
          mode: 'full',
          urlFilter: /recherche|api|items/i
        },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'fr-FR',
        viewport: { width: 1366, height: 850 },
      };

      // Charger la Master Session si elle existe pour éviter le captcha
      if (fs.existsSync(GLOBAL_SESSION_PATH)) {
        contextOptions.storageState = GLOBAL_SESSION_PATH;
        this.emit('log', { level: 'info', message: '🔑 Chargement de la session globale (Master Session)...' });
      }

      context = await browser.newContext(contextOptions);

      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      page = await context.newPage();

      for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        if (this.isCancelled) break;

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
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });

          // 🤖 DÉTECTION DE CAPTCHA / BLOCAGE
          const checkBlock = async () => {
            try {
              // On regarde le titre de la page et le texte visible du body
              const visibleText = await page.evaluate(() => {
                return (document.title + " " + document.body.innerText).toLowerCase();
              });
              return BLOCK_MARKERS.some(marker => visibleText.includes(marker));
            } catch (e) {
              return false;
            }
          };

          let isBlocked = await checkBlock();
          if (isBlocked) {
            this.emit('log', { level: 'warn', message: `⚠️ [Page ${pageNum}] BLOCAGE DÉTECTÉ. MERCI DE RÉSOUDRE LE CAPTCHA DANS CHROME.` });
            // Boucle d'attente jusqu'à résolution
            while (isBlocked && !this.isCancelled) {
              await sleep(2000);
              isBlocked = await checkBlock();
            }
            this.emit('log', { level: 'info', message: `✅ Reprise après validation humaine.` });
            await sleep(1000);
          }
        } catch (gotoErr) {
          this.emit('log', { level: 'warn', message: `[Page ${pageNum}] Avertissement : ${gotoErr.message}` });
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
      this.emit('log', { level: 'info', message: `✅ Session synchronisée.` });

      return outputHarPath;
    } catch (err) {
      this.emit('log', { level: 'error', message: `❌ Erreur : ${err.message}` });
      throw err;
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
}

module.exports = { HarCapturer };