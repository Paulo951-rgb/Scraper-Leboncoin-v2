#!/usr/bin/env node
/* =========================================================================
 * leboncoin-pipeline.js (Batching In-Page + Exit Propre)
 * =========================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { sleep, randomDelay, atomicWriteFileSync, cleanText } = require('../utils/helpers');

const DEFAULTS = Object.freeze({
  // ⚡ TURBO-MODE : 10 requêtes In-Page simultanées, délais très courts.
  minDelayMs: 500,
  maxDelayMs: 1000,
  headless: false,
  outDir: '.',
  batchSize: 10, // 10 requêtes simultanées = Vitesse multipliée par 5 !
  recycleContextEvery: 200, // Recycler la mémoire tous les 200 produits extraits
});

class CliError extends Error {}

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--concurrency':
        argv[++i]; // Ignorer silencieusement si transmis par un ancien script
        break;
      case '--fresh':
        opts.fresh = true;
        break;
      case '--headless':
        opts.headless = true;
        break;
      case '--csv':
        opts.csv = true;
        break;
      case '--no-desc':
        opts.noDesc = true;
        break;
      case '--limit':
        opts.limit = parseInt(argv[++i], 10);
        break;
      case '--out':
        opts.outDir = argv[++i];
        break;
      default:
        if (a.startsWith('--')) throw new CliError(`Option inconnue : ${a}`);
        positional.push(a);
    }
  }

  if (!positional[0]) throw new CliError('Le chemin du fichier .har est requis.');
  opts.harPath = positional[0];
  return opts;
}

function loadHar(harPath) {
  let raw = fs.readFileSync(harPath, 'utf8');
  const har = JSON.parse(raw);
  
  // 🟢 OPTIMISATION MÉMOIRE : Libérer immédiatement le tampon texte de 220 Mo de la RAM
  raw = null; 

  return har?.log?.entries || [];
}

function getJsonResponses(entries) {
  const jsonResponses = [];
  const IGNORED = /image|font\/|css|javascript|octet-stream|svg|video|audio/i;

  for (const entry of entries) {
    const res = entry.response;
    if (!res || !res.content) continue;
    if (typeof res.status === 'number' && res.status >= 400) continue;
    if (IGNORED.test(res.content.mimeType || '') && !res.content.mimeType.includes('json')) continue;

    let text = res.content.text;
    if (!text) continue;

    if (res.content.encoding === 'base64') {
      try {
        text = Buffer.from(text, 'base64').toString('utf8');
      } catch {
        continue;
      }
    }

    const trimmed = text.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
      const match = trimmed.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">\s*([\s\S]*?)\s*<\/script>/i);
      if (match && match[1]) {
        try {
          jsonResponses.push({ url: entry.request?.url || '', data: JSON.parse(match[1]) });
        } catch {
          /* Ignorer */
        }
      }
      continue;
    }

    try {
      jsonResponses.push({ url: entry.request?.url || '', data: JSON.parse(trimmed) });
    } catch {
      /* Ignorer */
    }
  }

  return jsonResponses;
}

function looksLikeAd(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const hasId = 'list_id' in obj || ('id' in obj && typeof obj.id !== 'object');
  const hasTitle = 'subject' in obj || 'title' in obj;
  const hasPriceOrUrl = 'price' in obj || 'url' in obj;
  return hasId && hasTitle && hasPriceOrUrl;
}

function findAdsIterative(root) {
  const found = [];
  const seen = new Set();
  const stack = [root];
  let visited = 0;

  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    visited++;
    if (visited > 500000) break;

    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }

    if (looksLikeAd(node)) found.push(node);

    for (const key of Object.keys(node)) stack.push(node[key]);
  }

  return found;
}

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return null;
}

function normalizeAd(raw) {
  const id = firstDefined(raw.list_id, raw.id, raw.ad_id);
  const title = firstDefined(raw.subject, raw.title, raw.name);
  const description = cleanText(firstDefined(raw.body, raw.description, raw.text));
  const url = firstDefined(raw.url, id ? `https://www.leboncoin.fr/ad/${id}.htm` : null);

  const city = firstDefined(raw.location?.city, raw.location?.city_label, raw.city);
  const zipcode = firstDefined(raw.location?.zipcode, raw.location?.zip_code);

  const imagesList = Array.isArray(raw.images?.urls) ? raw.images.urls : [];

  return {
    id: id != null ? String(id) : null,
    title: title || null,
    price: raw.price?.value ?? raw.price ?? null,
    description: description || null,
    url: url || null,
    images: imagesList,
    main_image: imagesList.length > 0 ? imagesList[0] : null,
    city: city || null,
    zipcode: zipcode || null,
    shipping: raw.has_option?.shipping ?? null,
    seller: firstDefined(raw.owner?.name, raw.owner_name),
    isPro: raw.owner?.type === 'pro',
    date: firstDefined(raw.first_publication_date, raw.index_date, raw.date),
    category: raw.category_name || null,
    raw,
  };
}

function mergeDuplicates(ads) {
  const byId = new Map();
  for (const ad of ads) {
    if (!ad.id) continue;
    if (byId.has(ad.id)) {
      const existing = byId.get(ad.id);
      const merged = { ...existing, ...ad };
      if (!existing.description && ad.description) merged.description = ad.description;
      byId.set(ad.id, merged);
    } else {
      byId.set(ad.id, ad);
    }
  }
  return [...byId.values()];
}

// -------------------------------------------------------------------------
// ENRICHISSEMENT DES DESCRIPTIONS BATCHING IN-PAGE
// -------------------------------------------------------------------------

class DescriptionEnricher {
  constructor(opts, logger) {
    this.opts = opts;
    this.logger = logger;
    this.consecutiveBlocks = 0;
    this.shouldStopAll = false;
  }

  async fetchBatchInPage(page, batchItems) {
    return await page.evaluate(async (items) => {
      const results = {};
      await Promise.all(
        items.map(async (item) => {
          try {
            const res = await fetch(item.url, {
              headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
            });
            if (!res.ok) {
              if (res.status === 403 || res.status === 429) results[item.id] = { error: 'BLOCKED_403' };
              else results[item.id] = { error: 'HTTP_' + res.status };
              return;
            }
            const html = await res.text();
            results[item.id] = { html };
          } catch (e) {
            results[item.id] = { error: e.message };
          }
        })
      );
      return results;
    }, batchItems);
  }

  parseHtmlDescription(html, adId) {
    if (!html) return null;
    const match = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">\s*([\s\S]*?)\s*<\/script>/i);
    if (match && match[1]) {
      try {
        const nextData = JSON.parse(match[1]);
        const found = findAdsIterative(nextData);
        const exact = found.find((c) => String(c.list_id || c.id) === String(adId));
        const target = exact || found[0];
        const body = target?.body || target?.description;
        if (body) return cleanText(body);
      } catch { /* Ignorer */ }
    }
    return null;
  }

  async enrichAll(ads, writeOutputs) {
    const targets = ads.filter((a) => a.url && !a.description);
    if (targets.length === 0) {
      this.logger.info('Toutes les annonces ont déjà une description !');
      return;
    }

    this.logger.info(`\nExtraction des descriptions pour ${targets.length} annonce(s) (Turbo-Mode x10)...`);

    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: this.opts.headless });

    const parentDir = path.dirname(this.opts.outDir);
    const statePath = path.join(parentDir, 'session-state.json');
    const globalStatePath = path.join(path.dirname(parentDir), 'global-session.json');

    const createStealthContext = async () => {
      const contextOptions = {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'fr-FR',
        viewport: { width: 1366, height: 850 },
      };

      const sessionToUse = fs.existsSync(globalStatePath) ? globalStatePath : (fs.existsSync(statePath) ? statePath : null);
      if (sessionToUse) {
        contextOptions.storageState = sessionToUse;
      }

      const ctx = await browser.newContext(contextOptions);
      const p = await ctx.newPage();
      
      await p.route('**/*', (route) => {
        if (['image', 'media', 'font', 'stylesheet'].includes(route.request().resourceType())) {
          return route.abort();
        }
        return route.continue();
      });

      await p.goto('https://www.leboncoin.fr', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(1500);
      return { ctx, p };
    };

    let setup = await createStealthContext();
    let context = setup.ctx;
    let page = setup.p;

    let done = 0;
    let successCount = 0;
    const batchSize = this.opts.batchSize || 10;

    for (let i = 0; i < targets.length; i += batchSize) {
      if (this.shouldStopAll) break;

      const batch = targets.slice(i, i + batchSize);
      const batchItems = batch.map((a) => ({ id: a.id, url: a.url }));

      const results = await this.fetchBatchInPage(page, batchItems);

      for (const ad of batch) {
        done++;
        const res = results[ad.id];

        if (res && res.html) {
          const desc = this.parseHtmlDescription(res.html, ad.id);
          if (desc) {
            ad.description = desc;
            successCount++;
            this.consecutiveBlocks = 0;
            this.logger.info(`✅ [${done}/${targets.length}] ${(ad.title || '').slice(0, 50)}`);
          } else {
            this.logger.warn(`⚠️ [${done}/${targets.length}] Description non trouvée sur ${ad.id}`);
          }
        } else if (res && res.error === 'BLOCKED_403') {
          this.consecutiveBlocks++;
          if (this.consecutiveBlocks >= 3) {
            this.shouldStopAll = true;
            this.logger.warn('\n🛑 Blocage détecté. Arrêt préventif.');
            break;
          }
        }
      }

      if (done % 10 === 0) writeOutputs(ads);
      await randomDelay(this.opts.minDelayMs, this.opts.maxDelayMs);

      if (done > 0 && done % this.opts.recycleContextEvery === 0) {
        this.logger.info(`🔄 Purge mémoire RAM (${done} items)...`);
        await page.close().catch(() => {});
        await context.close().catch(() => {});
        await sleep(1000);
        setup = await createStealthContext();
        context = setup.ctx;
        page = setup.p;
      }
    }

    writeOutputs(ads);
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    this.logger.info(`Session terminée : ${successCount}/${targets.length} récupérées.`);
  }
}

// -------------------------------------------------------------------------
// EXPORTATION DES FICHIERS
// -------------------------------------------------------------------------

function toReadableBlock(ad, index) {
  const imgLines = Array.isArray(ad.images) && ad.images.length > 0
    ? ad.images.map((img, i) => `  - Photo ${i + 1} : ${img}`).join('\n')
    : '  - Aucune photo';

  return [
    `===== ANNONCE ${index + 1} =====`,
    `ID          : ${ad.id ?? '-'}`,
    `Titre       : ${ad.title ?? '-'}`,
    `URL         : ${ad.url ?? '-'}`,
    `Prix        : ${ad.price != null ? ad.price + ' €' : '-'}`,
    `Ville       : ${ad.city ?? '-'}${ad.zipcode ? ' (' + ad.zipcode + ')' : ''}`,
    `Vendeur     : ${ad.seller ?? '-'}${ad.isPro ? ' (Pro)' : ''}`,
    `Date        : ${ad.date ?? '-'}`,
    `Photos (${ad.images ? ad.images.length : 0}) :`,
    imgLines,
    `Description :`,
    ad.description ? ad.description : '(non disponible)',
    '',
  ].join('\n');
}

function writeOutputsFactory(outDir, opts) {
  const jsonPath = path.join(outDir, 'annonces.json');
  const txtPath = path.join(outDir, 'annonces.txt');
  const csvPath = path.join(outDir, 'annonces.csv');

  return function writeOutputs(ads) {
    atomicWriteFileSync(jsonPath, JSON.stringify(ads, null, 2));
    atomicWriteFileSync(txtPath, ads.map(toReadableBlock).join('\n'));
    if (opts.csv) {
      const headers = ['id', 'title', 'price', 'city', 'seller', 'date', 'url', 'main_image', 'images', 'description'];
      const rows = [headers.join(',')];
      for (const a of ads) {
        const line = headers.map((h) => {
          const val = h === 'images' && Array.isArray(a.images) ? a.images.join(' ') : (a[h] || '');
          return `"${String(val).replace(/"/g, '""')}"`;
        }).join(',');
        rows.push(line);
      }
      atomicWriteFileSync(csvPath, rows.join('\n'));
    }
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Erreur CLI : ${err.message}`);
    process.exit(0);
  }

  const logger = {
    info: (msg) => console.log(`[${new Date().toLocaleTimeString()}] [INFO] ${msg}`),
    warn: (msg) => console.log(`\x1b[33m[${new Date().toLocaleTimeString()}] [WARN] ${msg}\x1b[0m`),
    error: (msg) => console.log(`\x1b[31m[${new Date().toLocaleTimeString()}] [ERROR] ${msg}\x1b[0m`),
  };

  logger.info('=== Pipeline Leboncoin (In-Page Batching Ultime) ===');

  const writeOutputs = writeOutputsFactory(opts.outDir, opts);
  const jsonPath = path.join(opts.outDir, 'annonces.json');

  let ads;
  if (fs.existsSync(jsonPath) && !opts.fresh) {
    logger.info('annonces.json existant trouvé -> Reprise automatique.');
    ads = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } else {
    const entries = loadHar(opts.harPath);
    const jsonResponses = getJsonResponses(entries);
    const rawAds = [];
    for (const r of jsonResponses) {
      const found = findAdsIterative(r.data);
      for (const f of found) rawAds.push(f);
    }

    const normalized = rawAds.map(normalizeAd).filter((a) => a.id || a.title);
    ads = mergeDuplicates(normalized);

    if (ads.length === 0) {
      logger.error('0 annonce extraite de ce HAR.');
      process.exit(0);
    }

    writeOutputs(ads);
    logger.info(`Étape HAR -> Annonces terminée : ${ads.length} annonces extraites.`);
  }

  if (opts.limit) ads = ads.slice(0, opts.limit);

  if (!opts.noDesc) {
    const enricher = new DescriptionEnricher(opts, logger);
    await enricher.enrichAll(ads, writeOutputs);
  }

  writeOutputs(ads);
  logger.info('\n✅ Opération terminée avec succès.');

  // 🛑 FIX CLEF : Fermeture explicite pour débloquer l'IPC Electron immédiatement !
  process.exit(0);
}

main().catch((err) => {
  console.error('Erreur fatale :', err.stack || err.message);
  process.exit(1);
});