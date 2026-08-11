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
const MAX_SNIPPETS = 6;        // réduit de 10 → 6 : moins de contexte consommé,
                              // laisse plus de place à la sortie (anti-troncation JSON)
const MAX_SNIPPET_CHARS = 250; // réduit de 300 → 250 (même raison)
const AI_NUM_CTX = 8192;       // contexte Ollama monté à 8192 (défaut 2048 trop petit :
                              // le prompt IA Marché ≈ 2000 tokens laissait ~0 token de
                              // sortie → JSON tronqué "realValue": 8 au lieu de 8000)

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
    // Le JSON peut être TRONQUÉ (contexte Ollama trop petit avant le fix num_ctx) :
    // ex: {"realValue": 8  (coupé en plein nombre, ouverte mais jamais fermée).
    // On tente une réparation best-effort : fermer les accolades/crochets ouverts
    // et re-parser. La valeur reste suspecte (tronquée), donc on marque
    // _repaired pour que l'appelant puisse baisser la confiance.
    return _repairTruncatedJson(txt, start);
  }
}

/**
 * Réparation best-effort d'un JSON tronqué par épuisement du contexte.
 * Compte les { [ ouverts non fermés et ajoute les fermetures manquantes.
 * Renvoie l'objet parsé (avec _repaired:true) ou null si irrécupérable.
 */
function _repairTruncatedJson(txt, start) {
  if (start === -1) return null;
  const slice = txt.slice(start);
  // Échec immédiat si pas au moins une clé "realValue"
  if (!/"realValue"\s*:/.test(slice)) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  if (depth <= 0) return null; // déjà équilibré → l'erreur venait d'ailleurs
  // Si on est tombé en plein milieu d'une valeur numérique/chaine non fermée,
  // on coupe juste avant le dernier séparateur incomplet puis on ferme.
  let repaired = slice.replace(/,\s*$/, '');
  // Coupe une éventuelle chaîne/valeur en cours (ex: "realValue": 8 → garde "realValue": 8)
  // puis ferme les conteneurs ouverts.
  repaired += '}'.repeat(Math.max(0, depth));
  try {
    const obj = JSON.parse(repaired);
    if (obj && typeof obj === 'object') {
      obj._repaired = true;
      return obj;
    }
  } catch {
    /* irrécupérable */
  }
  return null;
}

/**
 * Calcule le verdict (bénéfice/perte) à partir de la valeur estimée.
 * Pas de score/100 : juste la différence en € + un label simple.
 */
function computeVerdict(adPrice, realValue) {
  // Coerce en nombre : le prix d'annonce peut venir en string depuis le scraping
  // et realValue a déjà été normalisé (mais on garde la garde par sécurité).
  // ATTENTION : Number(null) === 0 (pas NaN), donc null doit être traité
  // explicitement comme "non déterminable" — sinon un realValue null devenait 0€
  // et le verdict se calculait faussement (perte énorme = "Très cher").
  if (adPrice == null || realValue == null) {
    return { verdict: 'Non déterminable', verdictLabel: 'Non déterminable', deltaEur: null, deltaPct: null };
  }
  const price = typeof adPrice === 'number' ? adPrice : Number(adPrice);
  const rv = typeof realValue === 'number' ? realValue : Number(realValue);
  if (!Number.isFinite(price) || !Number.isFinite(rv)) {
    return { verdict: 'Non déterminable', verdictLabel: 'Non déterminable', deltaEur: null, deltaPct: null };
  }
  const delta = Math.round((rv - price) * 100) / 100;
  const deltaPct = price > 0 ? Math.round((delta / price) * 100) : null;
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
        numCtx: AI_NUM_CTX,
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
    // JSON réparé (troncation contexte) : valeur potentiellement partielle →
    // on baisse la confiance pour signaler à l'utilisateur de vérifier.
    if (parsed._repaired) {
      console.warn(`[MarketValueAnalyzer] JSON réparé (troncation contexte) pour ${ad.id} — confiance baissée.`);
      parsed.confidence = 'basse';
      if (parsed.rationale) parsed.rationale = `[estimation partielle — JSON tronqué réparé] ${parsed.rationale}`;
      else parsed.rationale = 'Estimation partielle — JSON tronqué réparé (vérifier).';
    }

    // Normalise les champs numériques : un LLM peut renvoyer realValue sous forme
    // de chaîne ("300" voire "300 €"). On coerce en number, sinon null, pour que
    // computeVerdict et le renderer manipulent toujours des nombres propres.
    const toNum = (v) => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      if (typeof v === 'string') {
        const n = Number(v.replace(/[^\d.,-]/g, '').replace(',', '.'));
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };
    parsed.realValue = toNum(parsed.realValue);
    parsed.valueRangeLow = toNum(parsed.valueRangeLow);
    parsed.valueRangeHigh = toNum(parsed.valueRangeHigh);
    // Cohérence des bornes : low <= high (sinon on inverse pour ne pas afficher
    // une fourchette absurde si l'IA les a interverties).
    if (parsed.valueRangeLow != null && parsed.valueRangeHigh != null && parsed.valueRangeLow > parsed.valueRangeHigh) {
      const tmp = parsed.valueRangeLow;
      parsed.valueRangeLow = parsed.valueRangeHigh;
      parsed.valueRangeHigh = tmp;
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
    // Flush disque du cache IA : les set() sont debouncés. On force l'écriture
    // finale pour persister toutes les estimations de ce lot.
    aiCache._flushSave();
    return ads;
  }
}

module.exports = { MarketValueAnalyzer, _computeVerdict: computeVerdict, _parseMarket: parseMarket };
