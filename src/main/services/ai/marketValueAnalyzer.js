'use strict';

/**
 * MarketValueAnalyzer — IA 2 : analyse de marché via recherche Internet.
 *
 * TOTALEMENT SÉPARÉE de l'IA Analyse. Accessible depuis l'Explorateur des
 * annonces via le bouton « Analyse IA » (manuel, pas pendant le scraping).
 *
 * Pipeline :
 *   1. Construire une requête de recherche précise à partir du résumé IA 1
 *      (identifiedProduct + attributes.model + attributes.brand + condition).
 *   2. Rechercher le modèle précis sur Internet via un SearchProvider
 *      (DuckDuckGo sans-clé par défaut ; enfichable pour Tavily/Serper/etc.).
 *      → si le moteur échoue, on renvoie une erreur claire (JAMAIS inventer).
 *   3. Demander à l'IA locale de synthétiser les sources trouvées pour estimer
 *      la VALEUR RÉELLE du produit, en tenant compte de l'état réel.
 *   4. Calculer bénéfice / perte = (valeur réelle estimée) - (prix de l'annonce).
 *
 * PAS de système de points, PAS de multiplicateurs, PAS de scam score.
 * Le verdict repose uniquement sur la différence entre le prix de l'annonce et
 * la valeur réelle estimée du produit.
 *
 * Distinction cruciale : l'IA doit toujours différencier les sources RÉELLEMENT
 * trouvées (présentées à l'utilisateur) des informations déduites par l'IA.
 */

const { getAIProvider } = require('./providers/aiProviderRegistry');
const { getSearchProvider } = require('./search/searchProviderRegistry');
const aiCache = require('./aiCache');
const { truncate, formatMs } = require('../../utils/diagnostics');

const CACHE_PREFIX = 'market';
const SEARCH_LIMIT = 10;
const SEARCH_TIMEOUT_MS = 20000;
const AI_TIMEOUT_MS = 180000;
const MAX_SNIPPETS = 10;
const MAX_SNIPPET_CHARS = 300;

const SYSTEM = `Tu es un expert en estimation de la valeur réelle de produits vendus en ligne.
On te donne une annonce Leboncoin (produit identifié, état) et une liste de résultats de recherche Internet trouvés pour ce produit précis.

Ta mission : estimer la VALEUR RÉELLE du produit sur le marché de l'occasion (et neuf si pertinent), à partir des sources fournies.

RÈGLES STRICTES :
- Base-toi UNIQUEMENT sur les sources fournies. Ne pas inventer de prix.
- Différencie neuf, occasion et reconditionné.
- Ne compare PAS avec des modèles différents ou des variantes proches (ex: ne pas comparer une RTX 3060 12GB avec une 3060 Ti).
- Prends en compte l'état réel de l'objet (HS / pour pièces = valeur très faible).
- Identifie et écarte les prix aberrants ou non représentatifs (trop bas = arnaque, trop haut = non représentatif).
- Si les sources sont insuffisantes ou non pertinentes, dis-le clairement (confidence: 'basse', sourcesInsufficient: true).
- Réponds UNIQUEMENT avec un JSON valide, sans préambule ni markdown.`;

function buildSearchQuery(ad) {
  const a = ad.adAnalysis || {};
  const parts = [];
  if (a.attributes && a.attributes.model) parts.push(a.attributes.model);
  if (a.attributes && a.attributes.brand) parts.push(a.attributes.brand);
  if (parts.length === 0 && a.identifiedProduct) parts.push(a.identifiedProduct);
  if (parts.length === 0) parts.push(ad.title || '');

  const condition = a.attributes && a.attributes.condition;
  let condSuffix = '';
  if (condition) {
    const c = condition.toLowerCase();
    if (c.includes('hs') || c.includes('pièce')) condSuffix = ' pour pièces HS';
    else if (c.includes('neuf')) condSuffix = ' neuf';
    else if (c.includes('reconditionné') || c.includes('reconditionne')) condSuffix = ' reconditionné';
    else condSuffix = ' occasion';
  } else {
    condSuffix = ' occasion';
  }
  return `${parts.join(' ')}${condSuffix} prix`.trim();
}

function buildPrompt(ad, searchResults) {
  const a = ad.adAnalysis || {};
  const ident = a.identifiedProduct || ad.title || '(non identifié)';
  const attr = a.attributes || {};
  const condition = attr.condition || 'non précisé';
  const defects = Array.isArray(attr.defects) && attr.defects.length ? attr.defects.join(', ') : 'aucun';
  const working = attr.working || 'non précisé';

  const srcLines = searchResults
    .slice(0, MAX_SNIPPETS)
    .map((r, i) => `  ${i + 1}. [${r.source || r.url}] ${r.title || ''}\n     ${truncate(r.snippet || '', MAX_SNIPPET_CHARS)}\n     URL: ${r.url}`)
    .join('\n');

  const jsonSpec = `{
  "realValue": <estimation en euros (nombre), null si impossible>,
  "valueRangeLow": <borne basse plausible en euros, null>,
  "valueRangeHigh": <borne haute plausible en euros, null>,
  "condition": "neuf | occasion | reconditionné | pour_pièces | inconnu",
  "sourcesUsed": <nombre de sources réellement pertinentes utilisées>,
  "sourcesInsufficient": <true si pas assez de sources pertinentes>,
  "aberrantPricesFiltered": ["prix aberrants écartés et pourquoi, tableau vide si aucun"],
  "comparisonsAvoided": ["modèles proches écartés pour ne pas fausser l'estimation, tableau vide si aucun"],
  "rationale": "Explication claire (3-6 phrases) de l'estimation : sur quelles sources, quels prix, pourquoi cette valeur pour cet état.",
  "confidence": "haute | moyenne | basse"
}`;

  return `${SYSTEM}

=== PRODUIT À ESTIMER ===
Produit identifié: ${ident}
Modèle: ${attr.model || 'non précisé'}
Marque: ${attr.brand || 'non précisé'}
État réel: ${condition}
Défauts: ${defects}
Fonctionnement: ${working}

Prix de l'annonce Leboncoin: ${ad.price != null ? ad.price + ' €' : 'non précisé'}

=== SOURCES TROUVÉES SUR INTERNET ===
${searchResults.length > 0 ? srcLines : '(AUCUNE SOURCE TROUVÉE — moteur de recherche sans résultat ou en échec. Ne pas inventer de valeur.)'}

=== FORMAT DE RÉPONSE ===
Réponds UNIQUEMENT avec ce JSON exact :
${jsonSpec}`;
}

function parseMarket(rawText) {
  if (!rawText) return null;
  let txt = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = txt.indexOf('{');
  const end = txt.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) txt = txt.slice(start, end + 1);
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/**
 * Calcule le verdict (bénéfice/perte) à partir de la valeur estimée.
 * Pas de score/100 : juste la différence en € + un label simple.
 */
function computeVerdict(adPrice, realValue) {
  if (typeof adPrice !== 'number' || typeof realValue !== 'number') {
    return { verdict: 'Non déterminable', deltaEur: null };
  }
  const delta = Math.round((realValue - adPrice) * 100) / 100;
  const deltaPct = adPrice > 0 ? Math.round((delta / adPrice) * 100) : null;
  let label;
  if (delta >= 0) {
    // bénéfice potentiel
    if (deltaPct != null && deltaPct >= 40) label = 'Très bonne affaire';
    else if (deltaPct != null && deltaPct >= 15) label = 'Bonne affaire';
    else label = 'Prix correct';
  } else {
    if (deltaPct != null && deltaPct <= -40) label = 'Très cher';
    else if (deltaPct != null && deltaPct <= -15) label = 'Trop cher';
    else label = 'Prix correct';
  }
  const sign = delta > 0 ? '+' : '';
  const verdictText = `${label} — ${delta >= 0 ? 'bénéfice potentiel' : 'perte potentielle'} : ${sign}${delta} €`;
  return { verdict: verdictText, verdictLabel: label, deltaEur: delta, deltaPct };
}

function fallbackMarket(ad, reason, searchResults) {
  return {
    realValue: null,
    valueRangeLow: null,
    valueRangeHigh: null,
    condition: 'inconnu',
    sourcesUsed: Array.isArray(searchResults) ? searchResults.length : 0,
    sources: Array.isArray(searchResults) ? searchResults : [],
    sourcesInsufficient: true,
    aberrantPricesFiltered: [],
    comparisonsAvoided: [],
    rationale: `Analyse de marché indisponible : ${reason}.`,
    confidence: 'basse',
    verdict: 'Non déterminable',
    deltaEur: null,
    deltaPct: null,
    _fallback: true,
    _error: reason,
  };
}

class MarketValueAnalyzer {
  /**
   * Analyse de marché pour une annonce (recherche Internet + estimation IA).
   * @param {object} ad            doit contenir ad.adAnalysis (résultat IA 1)
   * @param {object} aiConfig      { provider, textModel, ollamaUrl }
   * @param {object} searchConfig  { provider, apiKey?, timeoutMs? } pour le moteur
   * @returns {Promise<object>}    résultat marché (toujours défini, fallback si échec)
   */
  static async analyzeMarket(ad, aiConfig = {}, searchConfig = {}) {
    if (!ad || !ad.id) throw new Error('MarketValueAnalyzer.analyzeMarket: annonce invalide.');
    if (!ad.adAnalysis) throw new Error('MarketValueAnalyzer: annonce sans adAnalysis (IA 1 manquante).');

    const cached = aiCache.get(ad.id, CACHE_PREFIX);
    if (cached && !cached._fallback) return cached;

    const t0 = Date.now();

    // 1. Recherche Internet
    const query = buildSearchQuery(ad);
    let searchRes;
    try {
      const engine = getSearchProvider(searchConfig);
      searchRes = await engine.search(query, { limit: SEARCH_LIMIT, timeoutMs: SEARCH_TIMEOUT_MS });
    } catch (err) {
      console.warn(`[MarketValueAnalyzer] moteur de recherche échoué pour ${ad.id} : ${err.message}`);
      return fallbackMarket(ad, `moteur de recherche indisponible : ${err.message}`, []);
    }

    if (!searchRes.ok || !searchRes.results || searchRes.results.length === 0) {
      console.warn(`[MarketValueAnalyzer] aucune source trouvée pour ${ad.id} : ${searchRes.message || '?'}`);
      return fallbackMarket(ad, searchRes.message || 'aucune source trouvée sur Internet', []);
    }

    // 2. Synthèse IA des sources
    const ai = getAIProvider(aiConfig);
    const prompt = buildPrompt(ad, searchRes.results);
    let raw;
    try {
      const opts = {
        jsonFormat: true,
        temperature: 0.3,
        timeoutMs: AI_TIMEOUT_MS,
      };
      if (aiConfig.textModel) opts.model = aiConfig.textModel;
      raw = await ai.chatText(prompt, opts);
    } catch (err) {
      console.warn(`[MarketValueAnalyzer] IA synthèse échouée pour ${ad.id} : ${err.message}`);
      return fallbackMarket(ad, `IA indisponible : ${err.message}`, searchRes.results);
    }

    const parsed = parseMarket(raw);
    if (!parsed) {
      console.warn(`[MarketValueAnalyzer] JSON invalide pour ${ad.id} : ${truncate(raw, 100)}`);
      return fallbackMarket(ad, 'Réponse IA non interprétable (JSON invalide).', searchRes.results);
    }

    // 3. Conserver les sources réellement trouvées (pour l'utilisateur)
    parsed.sources = searchRes.results.slice(0, MAX_SNIPPETS);
    parsed.query = query;

    // 4. Verdict (bénéfice/perte)
    const v = computeVerdict(ad.price, parsed.realValue);
    parsed.verdict = v.verdict;
    parsed.verdictLabel = v.verdictLabel;
    parsed.deltaEur = v.deltaEur;
    parsed.deltaPct = v.deltaPct;

    aiCache.set(ad.id, parsed, CACHE_PREFIX);
    console.log(`[MarketValueAnalyzer] ${ad.id} estimé en ${formatMs(Date.now() - t0)} → ${parsed.realValue != null ? parsed.realValue + '€' : 'N/A'} | ${parsed.verdict}`);
    return parsed;
  }

  /**
   * Analyse de marché pour un lot d'annonces (bouton Analyse IA sur sélection).
   * @param {Array} ads            annonces (avec adAnalysis)
   * @param {object} aiConfig
   * @param {object} searchConfig
   * @param {object} [opts] { concurrency, onProgress }
   */
  static async analyzeMarketBatch(ads, aiConfig = {}, searchConfig = {}, opts = {}) {
    const concurrency = Math.max(1, opts.concurrency || 3);
    const onProgress = opts.onProgress || (() => {});
    const total = ads.length;
    let done = 0;
    let searchOk = 0;
    let aiOk = 0;

    const queue = [...ads];
    const worker = async () => {
      while (queue.length > 0) {
        const ad = queue.shift();
        if (!ad) break;
        try {
          ad.marketAnalysis = await MarketValueAnalyzer.analyzeMarket(ad, aiConfig, searchConfig);
          if (ad.marketAnalysis && !ad.marketAnalysis._fallback) aiOk++;
          if (ad.marketAnalysis && Array.isArray(ad.marketAnalysis.sources) && ad.marketAnalysis.sources.length > 0) searchOk++;
        } catch (err) {
          ad.marketAnalysis = fallbackMarket(ad, err.message, []);
        }
        done++;
        onProgress({
          done, total,
          percent: Math.round((done / total) * 100),
          status: `Marché ${done}/${total} (recherche OK: ${searchOk}, estimation OK: ${aiOk})`,
          stageCounts: { searchOk, aiOk },
        });
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
    onProgress({ done: total, total, percent: 100, status: `Analyse marché terminée (recherche OK: ${searchOk}, estimation OK: ${aiOk}).`, stageCounts: { searchOk, aiOk } });
    return ads;
  }
}

module.exports = { MarketValueAnalyzer };
