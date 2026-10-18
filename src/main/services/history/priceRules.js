'use strict';

/**
 * priceRules — règles DÉTERMINISTES de validation et de segmentation des prix.
 *
 * Module PUR. Aucune valeur n'est inventée : un prix absent reste absent, un
 * prix invalide est signalé avec son MOTIF d'exclusion. Un prix atypique est
 * SIGNALÉ (jamais supprimé automatiquement au seul motif qu'il s'écarte de la
 * moyenne) : un prix très bas peut être une vraie opportunité.
 */

const { parsePriceString } = require('../scraping/adFields');

// Prix au-delà duquel une annonce est considérée comme manifestement hors
// échelle pour un particulier (ex. prix « sur demande » codé 999999999).
const ABSURD_PRICE_THRESHOLD = 10_000_000;

// Prix strictement positifs sous ce seuil : « symbolique » (1 €, 2 €…). Signalé
// mais conservé (peut être une vente réelle de pièce détachée).
const SYMBOLIC_PRICE_THRESHOLD = 5;

/**
 * Normalise une devise. La devise par défaut de Leboncoin est l'euro.
 * @param {*} currency
 * @returns {string} code ISO en majuscules
 */
function normalizeCurrency(currency) {
  if (currency == null || currency === '') return 'EUR';
  const s = String(currency).trim().toUpperCase();
  if (s === '€' || s === 'EUR' || s === 'EURO' || s === 'EUROS') return 'EUR';
  if (s === '$' || s === 'USD' || s === 'DOLLAR') return 'USD';
  if (s === '£' || s === 'GBP') return 'GBP';
  if (s === 'CHF') return 'CHF';
  // Code inconnu : on le conserve tel quel (pas de conversion inventée).
  return s.slice(0, 8);
}

/**
 * Analyse un prix brut et renvoie un verdict structuré.
 * @param {*} raw prix brut (number | string | null)
 * @param {Object} [opts]
 * @param {string} [opts.currency] devise observée
 * @returns {{value:number|null, currency:string, valid:boolean, excluded:boolean, reason:string|null, flags:string[]}}
 */
function analyzePrice(raw, opts = {}) {
  const currency = normalizeCurrency(opts.currency);
  const flags = [];
  const base = { value: null, currency, valid: false, excluded: true, reason: null, flags };

  if (raw == null || raw === '') {
    return { ...base, reason: 'missing' };
  }

  // Prix explicitement non numérique (« sur demande », « gratuit », « échange »).
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === '' ) return { ...base, reason: 'missing' };
    if (/gratuit|donne|free|echange|troc|sur demande|a debattre|negociable|prix a debattre|contact/.test(s)) {
      // On tente tout de même une extraction numérique (ex. « 100 € négociable »).
      const n = parsePriceString(raw);
      if (!Number.isFinite(n)) {
        return { ...base, reason: 'non_numeric' };
      }
    }
  }

  const n = typeof raw === 'number' ? (Number.isFinite(raw) ? raw : NaN) : parsePriceString(raw);
  if (!Number.isFinite(n)) {
    return { ...base, reason: 'non_numeric' };
  }
  if (n === 0) {
    return { ...base, value: 0, reason: 'zero' };
  }
  if (n < 0) {
    return { ...base, value: n, reason: 'negative' };
  }
  if (n > ABSURD_PRICE_THRESHOLD) {
    return { ...base, value: n, reason: 'absurd' };
  }

  // Prix valide et utilisable. Les cas « symbolique » et « atypique » sont des
  // FLAGS (conservés) et non des exclusions automatiques.
  if (n < SYMBOLIC_PRICE_THRESHOLD) flags.push('symbolic');

  return { value: n, currency, valid: true, excluded: false, reason: null, flags };
}

/**
 * Détecte un prix atypique par rapport à une distribution (règle IQR bornée).
 * Renvoie les bornes et les valeurs hors bornes — SANS les supprimer : c'est au
 * calcul statistique de décider (et d'afficher la raison).
 * @param {number[]} values prix valides
 * @returns {{q1:number, q3:number, iqr:number, lower:number, upper:number, outliers:number[]}|null}
 */
function detectOutliers(values) {
  const v = (Array.isArray(values) ? values : []).filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (v.length < 4) return null; // IQR non significatif en dessous de 4 points
  const q = (p) => {
    const idx = (v.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return v[lo];
    return v[lo] + (v[hi] - v[lo]) * (idx - lo);
  };
  const q1 = q(0.25);
  const q3 = q(0.75);
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  const outliers = v.filter((x) => x < lower || x > upper);
  return { q1, q3, iqr, lower, upper, outliers };
}

/**
 * Détecte les indices de COÛT SUPPLÉMENTAIRE (livraison) dans une annonce.
 * Ne JAMAIS présenter une estimation comme un prix observé : on renvoie
 * uniquement un booléen de disponibilité, sans montant inventé.
 * @param {Object} ad
 * @returns {{shippingAvailable:boolean, handDeliveryAvailable:boolean}}
 */
function deliveryAvailability(ad) {
  const dt = ad && ad.deliveryType;
  const shippingAvailable = dt === 'livraison' || dt === 'les_deux';
  const handDeliveryAvailable = dt === 'main_propre' || dt === 'les_deux';
  return { shippingAvailable, handDeliveryAvailable };
}

module.exports = {
  analyzePrice,
  normalizeCurrency,
  detectOutliers,
  deliveryAvailability,
  ABSURD_PRICE_THRESHOLD,
  SYMBOLIC_PRICE_THRESHOLD,
};
