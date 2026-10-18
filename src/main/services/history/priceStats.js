'use strict';

/**
 * priceStats — moteur STATISTIQUE DÉTERMINISTE et INDÉPENDANT de l'interface.
 *
 * Toutes les fonctions sont PURES (aucune dépendance base/UI) : on leur fournit
 * des observations (déjà datées) et elles renvoient des agrégats. Cela garantit
 * la REPRODUCTIBILITÉ : recalculer à partir des mêmes observations donne
 * exactement les mêmes résultats.
 *
 * Conventions DOCUMENTÉES (voir aussi docs/PRICE_EVOLUTION.md) :
 *   - moyenne = somme des prix valides / nombre de prix valides ;
 *   - médiane = pour un nombre PAIR de valeurs, moyenne des deux valeurs
 *     centrales ; pour un nombre IMPAIR, la valeur centrale ;
 *   - dispersion = écart-type d'échantillon (n-1) et écart interquartile ;
 *   - variation absolue = valeur finale − valeur initiale ;
 *   - variation relative (%) = (final − initial) / initial × 100, calculée
 *     UNIQUEMENT si la valeur initiale est valide et non nulle ;
 *   - aucune donnée ⇒ état « données insuffisantes » (jamais 0).
 *
 * ANTI-BIAIS : une annonce observée N fois ne compte qu'UNE fois par période.
 * On distingue systématiquement :
 *   - annonces distinctes (ads),
 *   - observations historiques (observations),
 *   - produits canoniques (products).
 */

// Version des règles de calcul : stockée avec les agrégats pour tracer un
// éventuel changement de méthode (et invalider un cache).
const STATS_METHOD_VERSION = 1;

/** Arrondi à 2 décimales (évite le bruit des flottants dans l'UI). */
function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : n;
}

/**
 * Statistiques descriptives d'une liste de valeurs (prix).
 * @param {number[]} values
 * @returns {{count:number, mean:number|null, median:number|null, min:number|null,
 *            max:number|null, p25:number|null, p75:number|null,
 *            stdDev:number|null, iqr:number|null, sufficient:boolean}}
 */
function describeValues(values) {
  const v = (Array.isArray(values) ? values : [])
    .filter((x) => typeof x === 'number' && Number.isFinite(x))
    .slice()
    .sort((a, b) => a - b);

  if (v.length === 0) {
    return { count: 0, mean: null, median: null, min: null, max: null, p25: null, p75: null, stdDev: null, iqr: null, sufficient: false };
  }

  const sum = v.reduce((s, x) => s + x, 0);
  const mean = sum / v.length;

  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 !== 0 ? v[mid] : (v[mid - 1] + v[mid]) / 2;

  const quantile = (p) => {
    const idx = (v.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return v[lo];
    return v[lo] + (v[hi] - v[lo]) * (idx - lo);
  };
  const p25 = quantile(0.25);
  const p75 = quantile(0.75);

  // Écart-type d'échantillon (n-1). Pour n=1, dispersion non définie → null.
  let stdDev = null;
  if (v.length >= 2) {
    const variance = v.reduce((s, x) => s + (x - mean) ** 2, 0) / (v.length - 1);
    stdDev = Math.sqrt(variance);
  }

  return {
    count: v.length,
    mean: round2(mean),
    median: round2(median),
    min: v[0],
    max: v[v.length - 1],
    p25: round2(p25),
    p75: round2(p75),
    stdDev: stdDev == null ? null : round2(stdDev),
    iqr: round2(p75 - p25),
    sufficient: true,
  };
}

/**
 * Calcule la variation entre une valeur initiale et une valeur finale.
 * @param {number|null} initial
 * @param {number|null} finalValue
 * @returns {{absolute:number|null, percent:number|null, direction:string|null}}
 */
function computeEvolution(initial, finalValue) {
  if (!Number.isFinite(initial) || !Number.isFinite(finalValue)) {
    return { absolute: null, percent: null, direction: null };
  }
  const absolute = round2(finalValue - initial);
  // Pourcentage non calculable si la valeur initiale est nulle (division par 0).
  const percent = initial !== 0 ? round2(((finalValue - initial) / initial) * 100) : null;
  let direction = 'stable';
  if (absolute > 0) direction = 'hausse';
  else if (absolute < 0) direction = 'baisse';
  return { absolute, percent, direction };
}

/**
 * Clé de période d'une date ISO.
 * @param {string} iso
 * @param {'day'|'week'|'month'} granularity
 * @returns {string|null} ex. '2026-10-18' | '2026-W42' | '2026-10'
 */
function periodKey(iso, granularity = 'day') {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  if (granularity === 'month') return `${y}-${m}`;
  if (granularity === 'week') {
    // Semaine ISO simplifiée (numéro de semaine basé sur le jeudi).
    const t = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()));
    const dayNum = (t.getUTCDay() + 6) % 7; // lundi = 0
    t.setUTCDate(t.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((t - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
    return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  return `${y}-${m}-${day}`;
}

/**
 * Construit une série temporelle à partir d'observations, en DÉDUPLIQUANT par
 * annonce et par période : une annonce observée 30 fois dans la journée ne
 * compte qu'UNE fois pour cette période (on retient sa dernière observation).
 *
 * IMPORTANT : aucune période sans observation n'est inventée — les points
 * manquants sont ABSENTS de la série (l'UI affiche un trou, pas un zéro).
 *
 * @param {Array<Object>} observations [{adId, observedAt, price, priceValid, condition, offerType}]
 * @param {Object} [opts] {granularity, includeInvalid, condition, offerType}
 * @returns {{granularity:string, points:Array<Object>}}
 */
function buildSeries(observations, opts = {}) {
  const granularity = opts.granularity || 'day';
  const includeInvalid = opts.includeInvalid === true;
  const obs = Array.isArray(observations) ? observations : [];

  // Filtre par segment si demandé.
  const filtered = obs.filter((o) => {
    if (!o || !o.observedAt) return false;
    if (opts.condition && o.condition !== opts.condition) return false;
    if (opts.offerType && o.offerType !== opts.offerType) return false;
    return true;
  });

  // (période, adId) → dernière observation de la période pour cette annonce.
  const byPeriodAd = new Map();
  for (const o of filtered) {
    const key = periodKey(o.observedAt, granularity);
    if (!key) continue;
    const mapKey = `${key}\u0000${o.adId}`;
    const prev = byPeriodAd.get(mapKey);
    if (!prev || String(o.observedAt) >= String(prev.observedAt)) {
      byPeriodAd.set(mapKey, o);
    }
  }

  // Regroupe par période.
  const byPeriod = new Map(); // key → { prices:[], ads:Set }
  for (const [mapKey, o] of byPeriodAd.entries()) {
    const key = mapKey.split('\u0000')[0];
    const valid = includeInvalid || o.priceValid !== false;
    if (!valid || !Number.isFinite(o.price)) continue;
    if (!byPeriod.has(key)) byPeriod.set(key, { prices: [], ads: new Set() });
    const bucket = byPeriod.get(key);
    bucket.prices.push(o.price);
    bucket.ads.add(o.adId);
  }

  const points = [];
  for (const key of [...byPeriod.keys()].sort()) {
    const { prices, ads } = byPeriod.get(key);
    const stats = describeValues(prices);
    points.push({
      period: key,
      median: stats.median,
      mean: stats.mean,
      min: stats.min,
      max: stats.max,
      ads: ads.size,
      observations: prices.length,
      stats,
    });
  }
  return { granularity, points };
}

/**
 * Agrège une liste d'observations en statistiques complètes (globales +
 * segments) avec indicateurs de qualité.
 *
 * @param {Array<Object>} observations observations rattachées au produit
 * @param {Object} [opts]
 * @param {string} [opts.granularity='day']
 * @param {string} [opts.nowIso] date de référence (fraîcheur)
 * @param {number} [opts.identifiedCount] nb d'annonces identifiées avec certitude
 * @param {number} [opts.totalLinkedAds] nb d'annonces liées (toutes décisions)
 * @returns {Object}
 */
function buildProductStats(observations, opts = {}) {
  const obs = Array.isArray(observations) ? observations : [];
  const granularity = opts.granularity || 'day';
  const nowIso = opts.nowIso || new Date().toISOString();

  // Observations valides (prix utilisable) pour les statistiques de prix.
  const validObs = obs.filter((o) => o && o.priceValid !== false && Number.isFinite(o.price));

  // Un produit NON FONCTIONNEL (hors service / à réparer) n'a pas une valeur
  // comparable à un produit fonctionnel : sa présence ne doit PAS tirer la
  // moyenne/médiane vers le bas. Ces observations sont donc EXCLUES de la
  // série principale et affichées dans un segment dédié (byCondition.for_parts).
  const isNonFunctional = (o) => o.condition === 'for_parts';
  const comparableObs = validObs.filter((o) => !isNonFunctional(o));
  const nonComparableObs = validObs.filter(isNonFunctional);

  // Une annonce contribue UNE fois aux statistiques globales : on retient sa
  // DERNIÈRE observation valide (état le plus récent connu).
  const lastByAd = new Map();
  for (const o of comparableObs) {
    const prev = lastByAd.get(o.adId);
    if (!prev || String(o.observedAt) >= String(prev.observedAt)) lastByAd.set(o.adId, o);
  }
  const latestValues = [...lastByAd.values()].map((o) => o.price);
  const overall = describeValues(latestValues);

  const distinctAds = lastByAd.size;
  const observationsCount = obs.length;
  const validObservations = validObs.length;
  const excludedObservations = observationsCount - validObservations;

  // Dernière observation (toutes confondues, y compris invalide).
  let lastObservedAt = null;
  for (const o of obs) {
    if (o && o.observedAt && (!lastObservedAt || String(o.observedAt) > String(lastObservedAt))) lastObservedAt = o.observedAt;
  }

  // Série temporelle (globale) : uniquement les observations comparables.
  const series = buildSeries(comparableObs, { granularity });

  // Évolution : médiane de la première période non vide → médiane de la dernière.
  let evolution = { absolute: null, percent: null, direction: null, from: null, to: null };
  if (series.points.length >= 1) {
    const first = series.points[0];
    const last = series.points[series.points.length - 1];
    evolution = {
      ...computeEvolution(first.median, last.median),
      from: { period: first.period, median: first.median },
      to: { period: last.period, median: last.median },
    };
  }

  // Segments : par état, puis par type d'offre. Chaque segment a ses PROPRES
  // statistiques (ne jamais mélanger un neuf et un hors service).
  const byCondition = {};
  const byOfferType = {};
  for (const o of validObs) {
    const c = o.condition || 'unknown';
    if (!byCondition[c]) byCondition[c] = [];
    byCondition[c].push(o);
    const ot = o.offerType || 'single';
    if (!byOfferType[ot]) byOfferType[ot] = [];
    byOfferType[ot].push(o);
  }
  const segmentStats = (map) => {
    const out = {};
    for (const [k, list] of Object.entries(map)) {
      const last = new Map();
      for (const o of list) {
        const prev = last.get(o.adId);
        if (!prev || String(o.observedAt) >= String(prev.observedAt)) last.set(o.adId, o);
      }
      out[k] = describeValues([...last.values()].map((o) => o.price));
      out[k].ads = last.size;
    }
    return out;
  };

  // Qualité statistique : indicateurs pour juger la fiabilité SANS promettre
  // une précision non démontrée.
  const identifiedCount = opts.identifiedCount ?? distinctAds;
  const totalLinkedAds = opts.totalLinkedAds ?? distinctAds;
  const freshnessDays = lastObservedAt ? Math.max(0, Math.round((new Date(nowIso) - new Date(lastObservedAt)) / 86400000)) : null;
  const quality = {
    distinctAds,
    observations: observationsCount,
    validObservations,
    excludedObservations,
    excludedRatio: observationsCount > 0 ? round2(excludedObservations / observationsCount) : 0,
    identifiedRatio: totalLinkedAds > 0 ? round2(identifiedCount / totalLinkedAds) : 0,
    freshnessDays,
    dispersion: overall.stdDev,
    iqr: overall.iqr,
    methodVersion: STATS_METHOD_VERSION,
    // Annonces écartées de la série principale car non comparables (hors
    // service) : signalées, jamais fondues dans la moyenne.
    nonComparableAds: new Set(nonComparableObs.map((o) => o.adId)).size,
    // Fiabilité qualitative : explicitement fondée sur le VOLUME d'annonces
    // distinctes, pas sur une prétendue probabilité.
    confidence: distinctAds >= 30 ? 'high' : distinctAds >= 10 ? 'medium' : distinctAds >= 3 ? 'low' : 'insufficient',
  };

  return {
    sufficient: overall.sufficient,
    reason: overall.sufficient ? null : 'no_valid_prices',
    overall,
    distinctAds,
    observationsCount,
    lastObservedAt,
    evolution,
    series,
    segments: { byCondition: segmentStats(byCondition), byOfferType: segmentStats(byOfferType) },
    quality,
    methodVersion: STATS_METHOD_VERSION,
  };
}

module.exports = {
  STATS_METHOD_VERSION,
  describeValues,
  computeEvolution,
  periodKey,
  buildSeries,
  buildProductStats,
  round2,
};
