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
const { getRandomUserAgent } = require('./userAgents');
const { writeWithChecksum } = require('../../utils/integrity');
const { AdaptiveRateLimiter } = require('../../utils/rateLimiter');
const adFields = require('./adFields');

const DEFAULTS = Object.freeze({
  // Mode rapide : fetchs parallèles (Promise.all) comme le code original.
  // batchSize = nb d'annonces par batch en parallèle. La détection 403 et
  // l'arrêt préventif après 3 blocages consécutifs restent actifs.
  minDelayMs: 500,
  maxDelayMs: 1000,
  headless: false,
  outDir: '.',
  batchSize: 10,
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
      case '--no-desc':
        opts.noDesc = true;
        break;
      case '--limit':
        opts.limit = parseInt(argv[++i], 10);
        break;
      case '--out':
        opts.outDir = argv[++i];
        break;
       case '--speed':
        opts.speed = argv[++i];
        break;
      case '--user-agent':
        opts.userAgent = argv[++i];
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

/**
 * Wrapper mince conservé pour les call sites existants (parseHtmlDescription).
 * Délègue désormais au module adFields (source unique de vérité).
 */
function extractCategory(raw) {
  return adFields.firstDefined(
    raw.category_name,
    raw.category?.name,
    raw.category?.label,
    raw.category_label,
    raw.category_name_json,
    null
  );
}

function extractDeliveryInfo(raw) {
  const t = adFields.extractTransaction(raw);
  return { shipping: t.livraison, handDelivery: t.mainPropre, deliveryMode: t.mode, deliveryLabel: t.deliveryLabel };
}

function extractSellerRating(raw) {
  const s = adFields.extractSeller(raw);
  return { sellerRating: s.rating, sellerRatingCount: s.ratingCount };
}

/**
 * Normalise une annonce brute Leboncoin en structure complète et stable.
 *
 * Sortie (compatible avec l'ancien code ET la nouvelle architecture v2) :
 *  - Champs legacy (à NE PAS supprimer — rétro-compat) : id, title, price,
 *    description, url, images, main_image, city, zipcode, shipping,
 *    handDelivery, deliveryMode, deliveryLabel, seller, isPro,
 *    sellerRating, sellerRatingCount, category, date.
 *  - Champs structurés v2 : prix{}, vendeur{}, transaction{}, statistiques{},
 *    dates{}, produit{}, photos{}, description{}, detection{}, scraping{}.
 *  - Champ `dateScraping` (ISO string) injecté au moment de la
 *    normalisation pour distinguer clairement « date publication » vs
 *    « date scraping ».
 *
 * IMPORTANT : ne JAMAIS inventer de valeur. Tout champ non trouvé est
 * `null`. Le texte de la description originale est conservé tel quel
 * (jamais résumé, jamais modifié).
 */
function normalizeAd(raw) {
  const id = adFields.firstDefined(raw.list_id, raw.id, raw.ad_id);
  const title = adFields.firstDefined(raw.subject, raw.title, raw.name);
  const descObj = adFields.extractDescription(raw);
  const description = descObj.nettoye;
  const url = adFields.firstDefined(raw.url, id ? `https://www.leboncoin.fr/ad/${id}.htm` : null);

  const city = adFields.firstDefined(raw.location?.city, raw.location?.city_label, raw.city);
  const zipcode = adFields.firstDefined(raw.location?.zipcode, raw.location?.zip_code);
  const department = adFields.zipcodeToDepartment(zipcode);

  const seller = adFields.extractSeller(raw);
  const transaction = adFields.extractTransaction(raw);
  const dates = adFields.extractDates(raw);
  const attributes = adFields.extractAttributes(raw);
  const priceObj = adFields.extractPrice(raw);
  const stats = adFields.extractStats(raw);
  const photos = adFields.extractPhotos(raw);

  // Détection de mots-clés dans la description (négociable, facture, etc.)
  const detected = adFields.detectInDescription(descObj.originale || descObj.nettoye);
  const conditionInferred = adFields.inferCondition(detected);

  // Date de scraping = maintenant (date d'extraction par NOTRE logiciel).
  // Toujours ISO string pour exploitation machine. Distincte de
  // dates.publication (date à laquelle Leboncoin a publié l'annonce).
  const scrapedAt = new Date().toISOString();

  const legacy = {
    id: id != null ? String(id) : null,
    title: title || null,
    price: priceObj.valeur,
    description: description || null,
    url: url || null,
    images: photos.urls,
    main_image: photos.main,
    city: city || null,
    zipcode: zipcode || null,
    shipping: transaction.livraison,
    handDelivery: transaction.mainPropre,
    deliveryMode: transaction.mode,
    deliveryLabel: transaction.deliveryLabel,
    seller: seller.name,
    isPro: seller.isPro,
    sellerRating: seller.rating,
    sellerRatingCount: seller.ratingCount,
    category: extractCategory(raw),
    date: dates.publication,
  };

  const ad = {
    ...legacy,
    // Champs structurés v2
    prix: {
      valeur: priceObj.valeur,
      devise: priceObj.devise,
      original: priceObj.original,
      negociable: priceObj.negociable,
    },
    vendeur: {
      nom: seller.name,
      nomMagasin: seller.storeName,
      type: seller.type,
      id: seller.id,
      isPro: seller.isPro,
      note: seller.rating,
      noteSur: 5,
      nombreAvis: seller.ratingCount,
      urlProfil: seller.profileUrl,
      ancienneteJours: seller.accountAgeDays,
      siren: seller.siren,
    },
    transaction: {
      livraison: transaction.livraison,
      mainPropre: transaction.mainPropre,
      mode: transaction.mode,
      transporteur: transaction.deliveryLabel,
    },
    statistiques: {
      likes: stats.likes,
      vues: stats.vues,
    },
    dates: {
      publication: dates.publication,
      modification: dates.modification,
      scraping: scrapedAt,
      statut: dates.status,
    },
    produit: {
      ...attributes.mapped,
      attributs: attributes.generic,
    },
    photos: {
      count: photos.count,
      urls: photos.urls,
      miniatures: photos.thumbnails,
      principale: photos.main,
      miniaturePrincipale: photos.mainThumbnail,
    },
    localisation: {
      ville: city || null,
      codePostal: zipcode || null,
      departement: department,
    },
    description: {
      originale: descObj.originale,
      nettoyee: descObj.nettoye,
      longueur: descObj.longueur,
    },
    detection: {
      ...detected,
      etatInferre: conditionInferred.etat,
      etatInferreLabel: conditionInferred.etatLabel,
    },
    raw,
  };

  // Scraping meta (statut + champs récupérés). Calculé à partir de la
  // structure finale pour donner une vue qualité du scraping par annonce.
  ad.scraping = adFields.scraperQuality(ad);

  // Compatibilité : les anciens code accèdent à `ad.date` et `ad.description`
  // directement. On garde ces champs (legacy). Le bloc structuré ci-dessus
  // ajoute les versions détaillées sans casser l'existant.
  return ad;
}

// Fusionne deux annonces en préservant les valeurs non-nulles : on ne remplace
// JAMAIS un champ déjà renseigné (non-null) par une valeur null provenant de
// l'autre version. Évite de perdre category/rating/shipping extraits sur une
// page quand l'autre occurrence ne les contient pas.
function mergeKeepingNonNull(existing, incoming) {
  const merged = { ...existing, ...incoming };
  for (const key of Object.keys(merged)) {
    if (existing[key] != null && incoming[key] == null) {
      merged[key] = existing[key];
    }
  }
  // raw reste l'objet brut le plus riche (on garde incoming.raw si plus de clés)
  merged.raw = existing.raw || incoming.raw;
  return merged;
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
      const merged = mergeKeepingNonNull(existing, ad);
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
    // 🛑 FIX : UA FIXE pour toute la durée de l'enrichissement. Avant,
    // getRandomUserAgent() était appelé dans createStealthContext → UA différent
    // à chaque recyclage de contexte (tous les 200 produits). Le UA choisi ici
    // peut être fourni par HarCapturer (opts.userAgent) pour garantir la cohérence
    // d'empreinte avec la phase de capture (mêmes cookies + même UA → 403 évité).
    this._userAgent = opts.userAgent || getRandomUserAgent();
    // Rate limiting adaptatif : ajuste dynamiquement les délais selon les
    // signaux du serveur (latence, 429/403, erreurs réseau).
    this.rateLimiter = new AdaptiveRateLimiter({
      baseDelayMs: opts.minDelayMs || 800,
      maxDelayMs: opts.maxDelayMs || 8000,
      slowThresholdMs: 3000,
      logger,
    });
  }

  async fetchBatchInPage(page, batchItems) {
    const sequential = this.opts.sequential === true;
    return await page.evaluate(async ({ items, seq }) => {
      const results = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      if (seq) {
        // MODE PRUDENT : séquentiel avec délais humains (anti-blocage max)
        for (const item of items) {
          try {
            const res = await fetch(item.url, {
              headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
            });
            if (!res.ok) {
              if (res.status === 403 || res.status === 429) results[item.id] = { error: 'BLOCKED_403' };
              else results[item.id] = { error: 'HTTP_' + res.status };
            } else {
              const html = await res.text();
              results[item.id] = { html };
            }
          } catch (e) {
            results[item.id] = { error: e.message };
          }
          if (items.indexOf(item) < items.length - 1) {
            await sleep(800 + Math.random() * 1000);
          }
        }
      } else {
        // MODE RAPIDE/ÉQUILIBRÉ : fetchs parallèles (Promise.all)
        const promises = items.map(async (item) => {
          try {
            const res = await fetch(item.url, {
              headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
            });
            if (!res.ok) {
              if (res.status === 403 || res.status === 429) results[item.id] = { error: 'BLOCKED_403' };
              else results[item.id] = { error: 'HTTP_' + res.status };
            } else {
              const html = await res.text();
              results[item.id] = { html };
            }
          } catch (e) {
            results[item.id] = { error: e.message };
          }
        });
        await Promise.all(promises);
      }
      return results;
    }, { items: batchItems, seq: sequential });
  }

  parseHtmlDescription(html, adId) {
    if (!html) return { description: null, shipping: null, category: null, sellerRating: null, sellerRatingCount: null, deliveryMode: null, handDelivery: null, deliveryLabel: null };
    const match = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">\s*([\s\S]*?)\s*<\/script>/i);
    if (match && match[1]) {
      try {
        const nextData = JSON.parse(match[1]);
        const found = findAdsIterative(nextData);
        const exact = found.find((c) => String(c.list_id || c.id) === String(adId));
        const target = exact || found[0];
        const body = target?.body || target?.description;

        // Extraction enrichie depuis la page de détail (qui contient souvent
        // PLUS de données que la liste de recherche : catégorie exacte, note
        // vendeur, options de livraison détaillées).
        const delivery = target ? extractDeliveryInfo(target) : null;
        const { sellerRating, sellerRatingCount } = target ? extractSellerRating(target) : { sellerRating: null, sellerRatingCount: null };

        return {
          description: body ? cleanText(body) : null,
          shipping: delivery ? delivery.shipping : null,
          category: target ? extractCategory(target) : null,
          sellerRating,
          sellerRatingCount,
          deliveryMode: delivery ? delivery.deliveryMode : null,
          handDelivery: delivery ? delivery.handDelivery : null,
          deliveryLabel: delivery ? delivery.deliveryLabel : null,
        };
      } catch { /* Ignorer */ }
    }
    return { description: null, shipping: null, category: null, sellerRating: null, sellerRatingCount: null, deliveryMode: null, handDelivery: null, deliveryLabel: null };
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

    this.logger.info(`\nExtraction des descriptions pour ${targets.length} annonce(s) (mode rapide parallèle)...`);
    this.logger.debug(`[DescriptionEnricher] Cibles : ${targets.length} | déjà avec description : ${alreadyHasDesc} | sans URL : ${noUrlCount} | batchSize : ${this.opts.batchSize || 5} | headless : ${this.opts.headless}`);

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
        userAgent: this._userAgent,
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

    let setup;
    let context;
    let page;
    try {
      setup = await createStealthContext();
      context = setup.ctx;
      page = setup.p;

    let done = 0;
    let successCount = 0;
    let notFoundCount = 0;
    let httpErrorCount = 0;
    let blockedCount = 0;
    const batchSize = this.opts.batchSize || 5;
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
          const parsed = this.parseHtmlDescription(res.html, ad.id);
          // Enrichissement des champs extraits de la page de détail.
          // IMPORTANT : on applique les infos de livraison (shipping, deliveryMode,
          // etc.) MÊME si la description n'a pas été trouvée — sur la page de
          // détail, les __NEXT_DATA__ contiennent souvent les attributs de
          // livraison dans un objet séparé du body. Avant, on skipait TOUT
          // l'enrichissement quand parsed.description était null, ce qui
          // laissait shipping=null (inconnu) même quand la page de détail
          // avait l'info → la "remise en main propre" n'était jamais détectée.
          let enriched = false;
          if (parsed.shipping != null && ad.shipping == null) { ad.shipping = parsed.shipping; enriched = true; }
          if (parsed.handDelivery != null && ad.handDelivery == null) { ad.handDelivery = parsed.handDelivery; enriched = true; }
          if (parsed.deliveryMode && parsed.deliveryMode !== 'inconnu' && (!ad.deliveryMode || ad.deliveryMode === 'inconnu')) {
            ad.deliveryMode = parsed.deliveryMode; enriched = true;
          }
          if (parsed.deliveryLabel && !ad.deliveryLabel) { ad.deliveryLabel = parsed.deliveryLabel; enriched = true; }
          if (parsed.category && !ad.category) { ad.category = parsed.category; enriched = true; }
          if (parsed.sellerRating != null && ad.sellerRating == null) { ad.sellerRating = parsed.sellerRating; enriched = true; }
          if (parsed.sellerRatingCount != null && ad.sellerRatingCount == null) { ad.sellerRatingCount = parsed.sellerRatingCount; enriched = true; }

          if (parsed.description) {
            ad.description = parsed.description;
            successCount++;
            this.consecutiveBlocks = 0;
            this.logger.info(`✅ [${done}/${targets.length}] ${(ad.title || '').slice(0, 50)}`);
          } else if (enriched) {
            // Pas de description, mais on a quand même enrichi des attributs
            // (livraison, catégorie, note vendeur) depuis les __NEXT_DATA__.
            successCount++;
            this.consecutiveBlocks = 0;
            this.logger.info(`✅ [${done}/${targets.length}] ${(ad.title || '').slice(0, 50)} (attributs enrichis, description absente)`);
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
      // Rate limiting adaptatif : on signale le résultat du batch au limiteur
      // qui ajuste dynamiquement le délai (backoff exponentiel si blocage,
      // accélération si succès rapides). Remplace le randomDelay fixe.
      const batchDuration = Date.now() - t0Batch;
      const batchHadBlock = batch.some((ad) => results[ad.id]?.error === 'BLOCKED_403');
      const batchHadError = batch.some((ad) => {
        const e = results[ad.id]?.error;
        return e && e !== 'BLOCKED_403' && !e.startsWith('HTTP_');
      });
      if (batchHadBlock) {
        await this.rateLimiter.waitAfter({ durationMs: batchDuration, blocked: true, status: 403 });
      } else if (batchHadError) {
        await this.rateLimiter.waitAfter({ durationMs: batchDuration, error: true });
      } else {
        await this.rateLimiter.waitAfter({ durationMs: batchDuration });
      }

      if (done > 0 && done % this.opts.recycleContextEvery === 0 && i + batchSize < targets.length) {
        this.logger.info(`🔄 Purge mémoire RAM (${done} items)...`);
        // Sauvegarde préventive AVANT le recyclage : si createStealthContext()
        // échoue pendant le recyclage (contexte Playwright instable après un
        // long run), on ne perd pas les descriptions déjà récupérées depuis le
        // dernier writeOutputs.
        writeOutputs(ads);
        await page.close().catch(() => {});
        await context.close().catch(() => {});
        await sleep(1000);
        try {
          setup = await createStealthContext();
          context = setup.ctx;
          page = setup.p;
        } catch (recycleErr) {
          // Recyclage impossible : on ne peut pas continuer à enrichir (le
          // navigateur est dans un état instable). On sauvegarde ce qu'on a et
          // on sort proprement plutôt que de crasher et perdre le job entier.
          this.logger.warn(`🛑 Recyclage contexte échoué : ${recycleErr.message} — arrêt de l'enrichissement, données sauvegardées.`);
          this.logger.debug(`[DescriptionEnricher] Détail échec recyclage : ${describeError(recycleErr)}`);
          context = null;
          page = null;
          break;
        }
      }
    }

    writeOutputs(ads);
    this.logger.info(`Session terminée : ${successCount}/${targets.length} récupérées.`);
    this.logger.debug(`[DescriptionEnricher] Bilan final : ${successCount} réussies | ${notFoundCount} sans description trouvée | ${blockedCount} bloquées (403/429) | ${httpErrorCount} autres erreurs HTTP/fetch | arrêt préventif : ${this.shouldStopAll ? 'OUI' : 'non'}.`);
    } finally {
      // Garanti la fermeture du navigateur/contexte/page même en cas d'erreur
      // (ex. createStealthContext ou fetchBatchInPage lance) — sinon Chromium
      // restait orphan (processus zombie) et la RAM/sockets fuyaient.
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }
}

// -------------------------------------------------------------------------
// EXPORTATION DES FICHIERS
// -------------------------------------------------------------------------

function _boolTri(v) {
  if (v === true) return 'OUI';
  if (v === false) return 'NON';
  return 'null';
}

function _fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function _fmtIso(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Bloc TXT lisible d'une annonce, en sections (GÉNÉRAL / VENDEUR / TRANSACTION
 * / STATISTIQUES / DATES / PRODUIT / PHOTOS / DESCRIPTION / SCRAPING). Toutes
 * les valeurs absentes affichent `null` ou `-` — JAMAIS d'invention.
 */
function toReadableBlock(ad, index) {
  const photos = ad.photos || {};
  const urls = Array.isArray(photos.urls) ? photos.urls : (Array.isArray(ad.images) ? ad.images : []);
  const imgLines = urls.length > 0
    ? urls.map((img, i) => `  - Photo ${i + 1} : ${img}`).join('\n')
    : '  - Aucune photo';

  const note = ad.vendeur?.note;
  const nbAvis = ad.vendeur?.nombreAvis;
  const ratingLine = note != null
    ? `Note vendeur    : ${note}/5${nbAvis != null ? ` (${nbAvis} avis)` : ''}`
    : 'Note vendeur    : null';

  const livraison = ad.transaction?.livraison;
  const mainPropre = ad.transaction?.mainPropre;
  const transporteur = ad.transaction?.transporteur;

  const lines = [
    `===== ANNONCE ${index + 1} =====`,
    '',
    'GÉNÉRAL',
    `ID                 : ${ad.id ?? 'null'}`,
    `Titre              : ${ad.title ?? 'null'}`,
    `URL                : ${ad.url ?? 'null'}`,
    `Prix               : ${ad.prix?.valeur != null ? ad.prix.valeur + ' €' : (ad.price != null ? ad.price + ' €' : 'null')}${ad.prix?.original != null ? ` (original : ${ad.prix.original} €)` : ''}`,
    `Catégorie          : ${ad.category ?? 'null'}`,
    `Sous-catégorie     : ${ad.produit?.type ?? 'null'}`,
    `Ville              : ${ad.localisation?.ville ?? ad.city ?? 'null'}`,
    `Code postal        : ${ad.localisation?.codePostal ?? ad.zipcode ?? 'null'}`,
    `Département        : ${ad.localisation?.departement ?? 'null'}`,
    '',
    'VENDEUR',
    `Nom                : ${ad.vendeur?.nom ?? ad.seller ?? 'null'}`,
    `Type               : ${ad.vendeur?.type ?? (ad.isPro ? 'pro' : 'particulier')}`,
    `ID vendeur         : ${ad.vendeur?.id ?? 'null'}`,
    ratingLine,
    `URL profil         : ${ad.vendeur?.urlProfil ?? 'null'}`,
    `Ancienneté (jours) : ${ad.vendeur?.ancienneteJours ?? 'null'}`,
    '',
    'TRANSACTION',
    `Livraison          : ${_boolTri(livraison)}${transporteur ? ` (${transporteur})` : ''}`,
    `Main propre        : ${_boolTri(mainPropre)}`,
    `Négociable         : ${_boolTri(ad.prix?.negociable)}`,
    `Facture            : ${_boolTri(ad.detection?.facture)}`,
    `Garantie           : ${_boolTri(ad.detection?.garantie)}`,
    `Échange accepté    : ${_boolTri(ad.detection?.echangeAccepte)}`,
    `Urgence            : ${_boolTri(ad.detection?.urgent)}`,
    '',
    'STATISTIQUES',
    `Likes              : ${ad.statistiques?.likes ?? 'null'}`,
    `Vues               : ${ad.statistiques?.vues ?? 'null'}`,
    '',
    'DATES',
    `Date publication   : ${_fmtIso(ad.dates?.publication) ?? 'null'}`,
    `Date modification  : ${_fmtIso(ad.dates?.modification) ?? 'null'}`,
    `Date scraping      : ${_fmtIso(ad.dates?.scraping) ?? 'null'}`,
    `Statut annonce     : ${ad.dates?.statut ?? 'null'}`,
    '',
    'PRODUIT',
    `Marque             : ${ad.produit?.brand ?? 'null'}`,
    `Modèle             : ${ad.produit?.model ?? 'null'}`,
    `Couleur            : ${ad.produit?.color ?? 'null'}`,
    `Taille             : ${ad.produit?.size ?? 'null'}`,
    `Capacité           : ${ad.produit?.capacity ?? 'null'}`,
    `Année              : ${ad.produit?.year ?? 'null'}`,
    `Matière            : ${ad.produit?.material ?? 'null'}`,
    `État déclaré       : ${ad.produit?.condition ?? 'null'}`,
    `État détecté       : ${ad.detection?.etatInferreLabel ?? 'null'}`,
    `Référence          : ${ad.produit?.reference ?? 'null'}`,
    '',
    'PHOTOS',
    `Nombre             : ${urls.length}`,
    `Photo principale   : ${urls[0] ?? 'null'}`,
    imgLines,
    '',
    'DESCRIPTION',
    `Longueur           : ${ad.description?.longueur ?? (ad.description ? String(ad.description).length : 0)} caractères`,
    ad.description?.originale || ad.description || '(non disponible)',
    '',
    'QUALITÉ DU SCRAPING',
    `Statut             : ${ad.scraping?.statut ?? 'unknown'}`,
    `Champs récupérés   : ${ad.scraping?.champsRecuperes ?? 0}/${ad.scraping?.champsTotal ?? 0}`,
    `Champs manquants   : ${(ad.scraping?.champsManquants || []).join(', ') || 'aucun'}`,
    '',
    '========================',
    '',
  ];
  return lines.join('\n');
}

function writeOutputsFactory(outDir, opts) {
  const jsonPath = path.join(outDir, 'annonces.json');
  const txtPath = path.join(outDir, 'annonces.txt');

  return function writeOutputs(ads) {
    // Rafraîchit la date de scraping et la qualité du scraping pour chaque
    // annonce avant l'écriture (les timestamps doivent correspondre à
    // l'écriture disque la plus récente).
    for (const ad of ads) {
      if (ad && typeof ad === 'object') {
        if (!ad.dates) ad.dates = {};
        ad.dates.scraping = new Date().toISOString();
        // Recalcule la qualité : certains champs peuvent avoir été enrichis
        // par le DescriptionEnricher (description, livraison, vendeur...).
        ad.scraping = adFields.scraperQuality(ad);
      }
    }
    writeWithChecksum(jsonPath, ads, null, 2);
    atomicWriteFileSync(txtPath, ads.map(toReadableBlock).join('\n'));
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Erreur CLI : ${err.message}`);
    // Exit code 1 (erreur) : le PipelineRunner doit savoir que le pipeline a
    // échoué, sinon il voit code 0 et croit que tout s'est bien passé.
    process.exit(1);
  }

  // Preset de vitesse : ajuste batchSize et délais selon le choix utilisateur
  const SPEED_PRESETS = {
    ultra:    { batchSize: 20, minDelayMs: 0,    maxDelayMs: 300,  mode: 'parallèle' },
    fast:     { batchSize: 10, minDelayMs: 500,  maxDelayMs: 1000, mode: 'parallèle' },
    balanced: { batchSize: 5,  minDelayMs: 1000, maxDelayMs: 2000, mode: 'parallèle' },
    safe:     { batchSize: 5,  minDelayMs: 1500, maxDelayMs: 3000, mode: 'séquentiel' },
  };
  const preset = SPEED_PRESETS[opts.speed] || SPEED_PRESETS.fast;
  opts.batchSize = preset.batchSize;
  opts.minDelayMs = preset.minDelayMs;
  opts.maxDelayMs = preset.maxDelayMs;
  opts.sequential = (opts.speed === 'safe');

  const ts = () => new Date().toLocaleTimeString();
  const logger = {
    debug: (msg) => console.log(`[${ts()}] [DEBUG] ${msg}`),
    info: (msg) => console.log(`[${ts()}] [INFO] ${msg}`),
    warn: (msg) => console.log(`\x1b[33m[${ts()}] [WARN] ${msg}\x1b[0m`),
    error: (msg) => console.log(`\x1b[31m[${ts()}] [ERROR] ${msg}\x1b[0m`),
  };

  logger.info(`=== Pipeline Leboncoin (Vitesse: ${opts.speed || 'fast'} — ${preset.mode}, batchSize=${preset.batchSize}) ===`);
  logger.debug(`[main] Options : harPath=${opts.harPath} | outDir=${opts.outDir} | headless=${opts.headless}  noDesc=${opts.noDesc} | limit=${opts.limit ?? '(aucun)'} | fresh=${opts.fresh} | speed=${opts.speed || 'fast'} | batchSize=${opts.batchSize} | minDelay=${opts.minDelayMs} | maxDelay=${opts.maxDelayMs}`);

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
    const shippingTrue = ads.filter((a) => a.shipping === true).length;
    const shippingFalse = ads.filter((a) => a.shipping === false).length;
    const shippingNull = ads.filter((a) => a.shipping == null).length;
    logger.debug(`[main] ${summarizeAds(ads)}`);
    logger.debug(`[main] Livraison : ${shippingTrue} avec shipping=true | ${shippingFalse} avec shipping=false | ${shippingNull} sans info shipping (null).`);
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