#!/usr/bin/env node
/* =========================================================================
 * leboncoin-pipeline.js (Batching In-Page + Exit Propre)
 * =========================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { sleep, randomDelay, atomicWriteFileSync, cleanText } = require('../../utils/helpers');
const { summarizeAds, summarizeHarEntries, truncate, formatBytes, formatMs } = require('../../utils/diagnostics');

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

function loadHar(harPath, logger) {
  if (!fs.existsSync(harPath)) {
    if (logger) logger.error(`[loadHar] Fichier HAR introuvable : ${harPath}`);
    throw new Error(`Fichier HAR introuvable : ${harPath}`);
  }
  const stat = fs.statSync(harPath);
  if (logger) logger.debug(`[loadHar] Lecture du fichier : ${harPath} (${formatBytes(stat.size)})`);

  let raw = fs.readFileSync(harPath, 'utf8');
  if (logger) logger.debug(`[loadHar] Fichier lu en mémoire : ${formatBytes(raw.length)} de texte`);

  let har;
  try {
    har = JSON.parse(raw);
  } catch (err) {
    if (logger) logger.error(`[loadHar] JSON invalide dans le fichier HAR : ${err.message}`);
    throw err;
  }
  // 🟢 OPTIMISATION MÉMOIRE : Libérer immédiatement le tampon texte de 220 Mo de la RAM
  raw = null;

  if (!har || !har.log) {
    if (logger) logger.error(`[loadHar] Structure HAR invalide : pas de propriété "log". Clés présentes : ${Object.keys(har || {}).join(', ') || '(aucune)'}`);
    return [];
  }
  const entries = har.log.entries || [];
  if (logger) logger.debug(`[loadHar] ${entries.length} entrée(s) HAR trouvées. ${summarizeHarEntries(entries)}`);
  return entries;
}

function getJsonResponses(entries, logger) {
  const jsonResponses = [];
  const IGNORED = /image|font\/|css|javascript|octet-stream|svg|video|audio/i;

  const stats = { total: entries.length, parsed: 0, noBody: 0, ignoredMime: 0, notJson: 0, nextDataFound: 0, parseError: 0, errorStatus: 0 };

  for (const entry of entries) {
    const res = entry.response;
    if (!res || !res.content) {
      stats.noBody++;
      continue;
    }
    if (typeof res.status === 'number' && res.status >= 400) {
      stats.errorStatus++;
      if (logger) logger.debug(`[getJsonResponses] Entrée en erreur HTTP ${res.status} ignorée : ${truncate(entry.request?.url, 80)}`);
      continue;
    }
    if (IGNORED.test(res.content.mimeType || '') && !res.content.mimeType.includes('json')) {
      stats.ignoredMime++;
      continue;
    }

    let text = res.content.text;
    if (!text) {
      stats.noBody++;
      continue;
    }

    if (res.content.encoding === 'base64') {
      try {
        text = Buffer.from(text, 'base64').toString('utf8');
      } catch {
        stats.parseError++;
        continue;
      }
    }

    const trimmed = text.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
      // Tentative d'extraction __NEXT_DATA__ depuis du HTML
      const match = trimmed.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">\s*([\s\S]*?)\s*<\/script>/i);
      if (match && match[1]) {
        try {
          jsonResponses.push({ url: entry.request?.url || '', data: JSON.parse(match[1]) });
          stats.nextDataFound++;
          stats.parsed++;
        } catch {
          stats.parseError++;
          if (logger) logger.debug(`[getJsonResponses] __NEXT_DATA__ JSON invalide dans : ${truncate(entry.request?.url, 80)}`);
        }
      } else {
        stats.notJson++;
      }
      continue;
    }

    try {
      jsonResponses.push({ url: entry.request?.url || '', data: JSON.parse(trimmed) });
      stats.parsed++;
    } catch {
      stats.parseError++;
    }
  }

  if (logger) {
    logger.debug(`[getJsonResponses] Stats extraction : ${stats.parsed} JSON parsés | ${stats.nextDataFound} via __NEXT_DATA__ | ${stats.ignoredMime} ignorés (mime) | ${stats.notJson} non-JSON | ${stats.noBody} sans corps | ${stats.errorStatus} en erreur HTTP | ${stats.parseError} erreurs de parsing`);
    if (jsonResponses.length > 0) {
      logger.debug(`[getJsonResponses] URLs JSON captées : ${jsonResponses.slice(0, 5).map((r) => truncate(r.url, 60)).join(' | ')}${jsonResponses.length > 5 ? ` (+${jsonResponses.length - 5} autres)` : ''}`);
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

function findAdsIterative(root, logger) {
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
    if (visited > 500000) {
      if (logger) logger.warn(`[findAdsIterative] Limite de parcours atteinte (500000 nœuds) — arret pour éviter une boucle infinie.`);
      break;
    }

    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }

    if (looksLikeAd(node)) found.push(node);

    for (const key of Object.keys(node)) stack.push(node[key]);
  }

  if (logger) logger.debug(`[findAdsIterative] ${visited} nœud(s) parcouru(s), ${found.length} objet(s) ressemblant à une annonce détecté(s).`);
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

function mergeDuplicates(ads, logger) {
  const byId = new Map();
  let noIdCount = 0;
  let dupCount = 0;
  for (const ad of ads) {
    if (!ad.id) {
      noIdCount++;
      continue;
    }
    if (byId.has(ad.id)) {
      const existing = byId.get(ad.id);
      const merged = { ...existing, ...ad };
      if (!existing.description && ad.description) merged.description = ad.description;
      byId.set(ad.id, merged);
      dupCount++;
    } else {
      byId.set(ad.id, ad);
    }
  }
  if (logger) logger.debug(`[mergeDuplicates] ${ads.length} annonce(s) en entrée | ${noIdCount} sans ID (ignorées) | ${dupCount} doublon(s) fusionné(s) | ${byId.size} unique(s) en sortie.`);
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
    const noUrlCount = ads.filter((a) => !a.url).length;
    const alreadyHasDesc = ads.filter((a) => a.description).length;
    if (targets.length === 0) {
      this.logger.info('Toutes les annonces ont déjà une description !');
      this.logger.debug(`[DescriptionEnricher] Rien à faire : ${alreadyHasDesc} avec description, ${noUrlCount} sans URL.`);
      return;
    }

    this.logger.info(`\nExtraction des descriptions pour ${targets.length} annonce(s) (Turbo-Mode x10)...`);
    this.logger.debug(`[DescriptionEnricher] Cibles : ${targets.length} | déjà avec description : ${alreadyHasDesc} | sans URL : ${noUrlCount} | batchSize : ${this.opts.batchSize || 10} | headless : ${this.opts.headless}`);

    const { chromium } = require('playwright');
    this.logger.debug(`[DescriptionEnricher] Lancement Chromium (headless=${this.opts.headless})...`);
    const t0Launch = Date.now();
    const browser = await chromium.launch({ headless: this.opts.headless });
    this.logger.debug(`[DescriptionEnricher] Chromium lancé en ${formatMs(Date.now() - t0Launch)}.`);

    const parentDir = path.dirname(this.opts.outDir);
    const statePath = path.join(parentDir, 'session-state.json');
    // outDir = JOBS_DIR/job-<timestamp>/results → parentDir = jobDir
    // La session globale est dans BASE_OUT_DIR/global-session.json, soit 2 niveaux
    // au-dessus de outDir (parentDir = jobDir, path.dirname(parentDir) = JOBS_DIR,
    // path.dirname(path.dirname(parentDir)) = BASE_OUT_DIR).
    const globalStatePath = path.join(path.dirname(path.dirname(parentDir)), 'global-session.json');

    const createStealthContext = async () => {
      const contextOptions = {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'fr-FR',
        viewport: { width: 1366, height: 850 },
      };

      const sessionToUse = fs.existsSync(globalStatePath) ? globalStatePath : (fs.existsSync(statePath) ? statePath : null);
      if (sessionToUse) {
        contextOptions.storageState = sessionToUse;
        this.logger.debug(`[DescriptionEnricher] Session utilisée : ${sessionToUse}`);
      } else {
        this.logger.debug(`[DescriptionEnricher] Aucune session trouvée (ni ${path.basename(globalStatePath)}, ni ${path.basename(statePath)}) — contexte vierge.`);
      }

      const ctx = await browser.newContext(contextOptions);
      const p = await ctx.newPage();
      
      await p.route('**/*', (route) => {
        if (['image', 'media', 'font', 'stylesheet'].includes(route.request().resourceType())) {
          return route.abort();
        }
        return route.continue();
      });

      const t0Goto = Date.now();
      await p.goto('https://www.leboncoin.fr', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => {
        this.logger.warn(`[DescriptionEnricher] Navigation initiale vers leboncoin.fr échouée : ${e.message} — le contexte reste toutefois utilisable pour les fetch in-page.`);
      });
      this.logger.debug(`[DescriptionEnricher] Page d'accueil chargée en ${formatMs(Date.now() - t0Goto)}.`);
      await sleep(1500);
      return { ctx, p };
    };

    let setup = await createStealthContext();
    let context = setup.ctx;
    let page = setup.p;

    let done = 0;
    let successCount = 0;
    let notFoundCount = 0;
    let httpErrorCount = 0;
    let blockedCount = 0;
    const batchSize = this.opts.batchSize || 10;
    let batchIndex = 0;

    for (let i = 0; i < targets.length; i += batchSize) {
      if (this.shouldStopAll) {
        this.logger.debug(`[DescriptionEnricher] Arrêt demandé (shouldStopAll=true) — sortie de la boucle à ${done}/${targets.length}.`);
        break;
      }

      const batch = targets.slice(i, i + batchSize);
      const batchItems = batch.map((a) => ({ id: a.id, url: a.url }));
      batchIndex++;
      this.logger.debug(`[DescriptionEnricher] Batch ${batchIndex} : ${batch.length} annonce(s) — IDs [${batchItems.map((b) => b.id).join(', ')}]`);

      const t0Batch = Date.now();
      const results = await this.fetchBatchInPage(page, batchItems);
      this.logger.debug(`[DescriptionEnricher] Batch ${batchIndex} terminé en ${formatMs(Date.now() - t0Batch)} — ${Object.keys(results).length}/${batch.length} réponses.`);

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
            notFoundCount++;
            this.logger.warn(`⚠️ [${done}/${targets.length}] Description non trouvée sur ${ad.id}`);
            this.logger.debug(`[DescriptionEnricher] HTML reçu (${formatBytes(res.html.length)}) mais pas de __NEXT_DATA__ ou pas de body pour l'ID ${ad.id}.`);
          }
        } else if (res && res.error === 'BLOCKED_403') {
          blockedCount++;
          this.consecutiveBlocks++;
          this.logger.warn(`🛑 [${done}/${targets.length}] Bloqué (HTTP 403/429) sur ${ad.id} — ${truncate(ad.url, 60)}`);
          if (this.consecutiveBlocks >= 3) {
            this.shouldStopAll = true;
            this.logger.warn('\n🛑 Blocage détecté. Arrêt préventif.');
            this.logger.debug(`[DescriptionEnricher] Raison arrêt : ${this.consecutiveBlocks} blocages consécutifs (seuil=3). ${blockedCount} blocages au total sur ce batch.`);
            break;
          }
        } else if (res && res.error && res.error.startsWith('HTTP_')) {
          httpErrorCount++;
          this.logger.warn(`⚠️ [${done}/${targets.length}] HTTP ${res.error.replace('HTTP_', '')} sur ${ad.id}`);
        } else if (res && res.error) {
          httpErrorCount++;
          this.logger.warn(`⚠️ [${done}/${targets.length}] Erreur fetch sur ${ad.id} : ${res.error}`);
        } else {
          httpErrorCount++;
          this.logger.warn(`⚠️ [${done}/${targets.length}] Aucune réponse reçue pour ${ad.id}`);
        }
      }

      if (done % 10 === 0) writeOutputs(ads);
      await randomDelay(this.opts.minDelayMs, this.opts.maxDelayMs);

      if (done > 0 && done % this.opts.recycleContextEvery === 0 && i + batchSize < targets.length) {
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
    this.logger.debug(`[DescriptionEnricher] Bilan final : ${successCount} réussies | ${notFoundCount} sans description trouvée | ${blockedCount} bloquées (403/429) | ${httpErrorCount} autres erreurs HTTP/fetch | arrêt préventif : ${this.shouldStopAll ? 'OUI' : 'non'}.`);
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

  const ts = () => new Date().toLocaleTimeString();
  const logger = {
    debug: (msg) => console.log(`[${ts()}] [DEBUG] ${msg}`),
    info: (msg) => console.log(`[${ts()}] [INFO] ${msg}`),
    warn: (msg) => console.log(`\x1b[33m[${ts()}] [WARN] ${msg}\x1b[0m`),
    error: (msg) => console.log(`\x1b[31m[${ts()}] [ERROR] ${msg}\x1b[0m`),
  };

  logger.info('=== Pipeline Leboncoin (In-Page Batching Ultime) ===');
  logger.debug(`[main] Options : harPath=${opts.harPath} | outDir=${opts.outDir} | headless=${opts.headless} | csv=${opts.csv} | noDesc=${opts.noDesc} | limit=${opts.limit ?? '(aucun)'} | fresh=${opts.fresh} | batchSize=${opts.batchSize || 10}`);

  const writeOutputs = writeOutputsFactory(opts.outDir, opts);
  const jsonPath = path.join(opts.outDir, 'annonces.json');

  let ads;
  if (fs.existsSync(jsonPath) && !opts.fresh) {
    logger.info('annonces.json existant trouvé -> Reprise automatique.');
    logger.debug(`[main] Reprise depuis : ${jsonPath}`);
    ads = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    logger.debug(`[main] ${summarizeAds(ads)}`);
  } else {
    logger.debug(`[main] Étape 1/3 : Chargement du HAR depuis ${opts.harPath}`);
    const entries = loadHar(opts.harPath, logger);

    logger.debug(`[main] Étape 2/3 : Extraction des réponses JSON depuis ${entries.length} entrée(s) HAR`);
    const jsonResponses = getJsonResponses(entries, logger);

    if (jsonResponses.length === 0) {
      logger.error('Aucune réponse JSON exploitable trouvée dans le HAR.');
      logger.warn(`[main] Causes possibles : (1) Leboncoin a bloqué la recherche (captcha/403) durant la capture HAR ; (2) structure du HAR différente de celle attendue ; (3) le fichier HAR est vide ou corrompu.`);
      logger.debug(`[main] Diagnostic : ${summarizeHarEntries(entries)}`);
      process.exit(0);
    }

    logger.debug(`[main] Étape 3/3 : Recherche d'annonces dans ${jsonResponses.length} réponse(s) JSON`);
    const rawAds = [];
    let responseWithAds = 0;
    for (const r of jsonResponses) {
      const found = findAdsIterative(r.data, logger);
      if (found.length > 0) responseWithAds++;
      for (const f of found) rawAds.push(f);
    }
    logger.debug(`[main] ${rawAds.length} objet(s) annonce brut(s) trouvé(s) dans ${responseWithAds}/${jsonResponses.length} réponse(s) JSON.`);

    if (rawAds.length === 0) {
      logger.warn('Aucun objet annonce trouvé dans les réponses JSON (les données HAR ne contiennent pas le format attendu).');
      logger.debug(`[main] Cela peut arriver si Leboncoin a changé sa structure JSON ou si la capture HAR a intercepté une page d'erreur au lieu des résultats de recherche.`);
    }

    const beforeFilter = rawAds.length;
    const normalized = rawAds.map(normalizeAd).filter((a) => a.id || a.title);
    const filteredOut = beforeFilter - normalized.length;
    if (filteredOut > 0) {
      logger.debug(`[main] Filtrage : ${filteredOut} objet(s) sans ID ni titre supprimé(s) après normalisation (${beforeFilter} → ${normalized.length}).`);
    }

    ads = mergeDuplicates(normalized, logger);

    if (ads.length === 0) {
      logger.error('0 annonce extraite de ce HAR.');
      logger.warn(`[main] Récapitulatif diagnostic : ${entries.length} entrées HAR | ${jsonResponses.length} JSON parsés | ${rawAds.length} annonces brutes | ${normalized.length} après normalisation | 0 après déduplication.`);
      logger.warn(`[main] Causes probables : page de recherche non chargée, réponse réseau absente, données reçues mais ne contenant pas d'annonces, ou filtre ayant tout supprimé.`);
      process.exit(0);
    }

    writeOutputs(ads);
    logger.info(`Étape HAR -> Annonces terminée : ${ads.length} annonces extraites.`);
    logger.debug(`[main] ${summarizeAds(ads)}`);
  }

  if (opts.limit) {
    logger.debug(`[main] Application de la limite : ${ads.length} → ${Math.min(opts.limit, ads.length)} annonces.`);
    ads = ads.slice(0, opts.limit);
  }

  if (!opts.noDesc) {
    logger.debug(`[main] Lancement de l'enrichissement des descriptions...`);
    const enricher = new DescriptionEnricher(opts, logger);
    await enricher.enrichAll(ads, writeOutputs);
  } else {
    logger.debug(`[main] Enrichissement des descriptions ignoré (option --no-desc).`);
  }

  writeOutputs(ads);
  logger.info('\n✅ Opération terminée avec succès.');
  logger.debug(`[main] Bilan final : ${summarizeAds(ads)}`);

  // 🛑 FIX CLEF : Fermeture explicite pour débloquer l'IPC Electron immédiatement !
  process.exit(0);
}

main().catch((err) => {
  console.error('Erreur fatale :', err.stack || err.message);
  process.exit(1);
});