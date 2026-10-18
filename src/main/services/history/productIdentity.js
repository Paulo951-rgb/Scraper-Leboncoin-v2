'use strict';

/**
 * productIdentity — moteur DÉTERMINISTE d'identification de produit.
 *
 * Rôle : décider si une annonce peut être rapprochée d'un produit canonique.
 * Le moteur NE décide JAMAIS par IA : il combine des indices pondérés
 * (référence, marque, famille, unités, similarité textuelle) et applique des
 * RÈGLES DE CONTRADICTION PRIORITAIRES. Un score textuel élevé ne peut JAMAIS
 * annuler une contradiction technique majeure (référence de modèle différente,
 * lot, accessoire, pièce détachée, hors service).
 *
 * DISTINCTION ESSENTIELLE DES RÉFÉRENCES (compareReferences) :
 *   - 'exact'    : identiques (9600X ≡ 9600X).
 *   - 'partial'  : différence de PRÉFIXE / code série uniquement (R59600X ≡
 *                  9600X ≡ 9600X) → MÊME modèle probable.
 *   - 'conflict' : différence de SUFFIXE de modèle (9600 vs 9600X,
 *                  3060 vs 3060 Ti) → MODÈLES DIFFÉRENTS : ne jamais fusionner.
 *   - 'none'     : aucune relation.
 *
 * Le moteur est INDÉPENDANT du stockage : il reçoit des produits candidats et
 * une annonce, et renvoie une décision + une recommandation d'action.
 */

const { normalizeReference, normalizeText, tokenize, dice } = require('./normalizeText');
const { extractFeatures, MODEL_SUFFIXES } = require('./featureExtractor');

// ─── Seuils (calibrés, documentés, surchargeables) ───────────────────────────
// Ces seuils proviennent de la campagne de tests (test/regression.test.js
// section [52]). Ils ne représentent PAS des probabilités : un score de 85 n'a
// aucune interprétation probabiliste — c'est un score interne de rapprochement.
const DEFAULT_THRESHOLDS = Object.freeze({
  // Score minimal pour une association automatique hors référence exacte.
  CONFIRM_MIN: 70,
  // Score minimal lorsque la référence est EXACTE ou une variante de PRÉFIXE :
  // la référence identifie le modèle, les indices secondaires ne font que
  // confirmer. Ce plancher écarte seulement les références « fortuites ».
  REFERENCE_EXACT_FLOOR: 55,
  // Score en dessous duquel on refuse d'office (bruit).
  REJECT_MAX: 25,
  // Écart minimal entre le meilleur candidat et le second pour trancher seul.
  AMBIGUITY_MARGIN: 8,
});

// Poids des indices du score. La RÉFÉRENCE est l'indice dominant.
const WEIGHTS = Object.freeze({
  referenceExact: 50,     // référence identique
  referencePartial: 40,   // variante de préfixe (même modèle)
  brand: 8,               // marque identique
  family: 10,             // famille identique
  units: 12,              // unités compatibles (capacité, puissance…)
  titleSimilarity: 12,    // similarité de tokens du titre
  descriptionSimilarity: 8, // similarité de tokens de la description
});

// Suffixes de modèle reconnus (utilisés pour la relation 'conflict').
const MODEL_SUFFIX_LIST = new Set([...MODEL_SUFFIXES].map((s) => s.toUpperCase()));

/**
 * Classe une référence relativement à une autre (voir en-tête du module).
 * @param {string} ra
 * @param {string} rb
 * @returns {'exact'|'partial'|'conflict'|'none'}
 */
function compareReferences(ra, rb) {
  const a = normalizeReference(ra);
  const b = normalizeReference(rb);
  if (!a || !b || a.length < 2 || b.length < 2) return 'none';
  if (a === b) return 'exact';

  // Relation de suffixe de modèle : l'un = l'autre + suffixe de modèle
  // (9600 vs 9600X). Ce sont des MODÈLES DIFFÉRENTS.
  const pairs = [[a, b], [b, a]];
  for (const [long, short] of pairs) {
    if (short.length >= 3 && long.startsWith(short)) {
      const tail = long.slice(short.length);
      if (MODEL_SUFFIX_LIST.has(tail)) return 'conflict';
    }
  }
  // Relation de préfixe/série : l'un contient l'autre (R59600X contient 9600X)
  // sans suffixe de modèle distinctif → MÊME modèle probable.
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) return 'partial';
  return 'none';
}

/**
 * Vérifie la compatibilité de deux ensembles d'unités.
 * @returns {{score:number, contradiction:boolean, reason:string|null, comparable:boolean}}
 */
function compareUnits(a, b) {
  const ua = a || {};
  const ub = b || {};
  const keys = new Set([...Object.keys(ua), ...Object.keys(ub)]);
  if (keys.size === 0) return { score: 0, contradiction: false, reason: null, comparable: false };
  let comparable = 0;
  let match = 0;
  let contradiction = false;
  let reason = null;
  for (const k of keys) {
    const va = ua[k];
    const vb = ub[k];
    if (va && vb && va.unit === vb.unit) {
      comparable++;
      if (Math.abs(va.value - vb.value) <= Math.max(1, va.value * 0.01)) match++;
      else if (['capacity_gb', 'capacity_tb', 'capacity_mb', 'power_w'].includes(k)) {
        // Une capacité/puissance explicitement différente est une contradiction
        // (8 Go ≠ 16 Go, 500 W ≠ 750 W) : ne jamais mélanger ces séries.
        contradiction = true;
        reason = `${k}:${va.value}≠${vb.value}`;
      }
    }
  }
  if (comparable === 0) return { score: 0, contradiction: false, reason: null, comparable: false };
  return { score: match / comparable, contradiction, reason, comparable: true };
}

/**
 * Évalue la compatibilité d'une annonce (features) avec un produit canonique.
 * @param {Object} features
 * @param {Object} product { reference, brand, family, units, titleTokens }
 * @param {Object} [thresholds]
 * @returns {Object}
 */
function scoreMatch(features, product, thresholds = DEFAULT_THRESHOLDS) {
  const f = features || {};
  const p = product || {};
  const reasons = {};
  const contradictions = [];

  // 1) Référence — indice le plus discriminant.
  const refRelation = compareReferences(f.primaryReference, p.reference);
  reasons.referenceRelation = refRelation;
  let score = 0;
  if (refRelation === 'exact') score += WEIGHTS.referenceExact;
  else if (refRelation === 'partial') score += WEIGHTS.referencePartial;
  else if (refRelation === 'conflict') {
    // Modèles différents (9600 vs 9600X) : contradiction MAJEURE. Aucun score
    // textuel ne doit la compenser.
    contradictions.push({ type: 'reference_model_variant', ad: f.primaryReference, product: p.reference, severity: 'high' });
  } else if (f.primaryReference && p.reference) {
    contradictions.push({ type: 'reference_incompatible', ad: f.primaryReference, product: p.reference, severity: 'high' });
  }

  // 2) Marque.
  if (f.brand && p.brand && normalizeText(f.brand) === normalizeText(p.brand)) {
    score += WEIGHTS.brand; reasons.brand = true;
  }

  // 3) Famille.
  if (f.family && p.family && f.family === p.family) {
    score += WEIGHTS.family; reasons.family = true;
  } else if (f.family && p.family && f.family !== p.family) {
    contradictions.push({ type: 'family_incompatible', ad: f.family, product: p.family, severity: 'high' });
  }

  // 4) Unités.
  const units = compareUnits(f.units, p.units);
  if (units.comparable) {
    score += Math.round(WEIGHTS.units * units.score);
    reasons.units = units.score;
    if (units.contradiction) contradictions.push({ type: 'units_incompatible', detail: units.reason, severity: 'high' });
  }

  // 5) Similarité textuelle.
  const pTitleTokens = Array.isArray(p.titleTokens) && p.titleTokens.length ? p.titleTokens : tokenize(p.title || '');
  const titleSim = dice(f.titleTokens || [], pTitleTokens);
  score += Math.round(WEIGHTS.titleSimilarity * titleSim);
  reasons.titleSimilarity = titleSim;
  if (f.hasDescription && Array.isArray(f.descTokens) && f.descTokens.length) {
    const pDescTokens = Array.isArray(p.descTokens) ? p.descTokens : [];
    if (pDescTokens.length) {
      const descSim = dice(f.descTokens, pDescTokens);
      score += Math.round(WEIGHTS.descriptionSimilarity * descSim);
      reasons.descriptionSimilarity = descSim;
    }
  }

  // 6) Contradictions internes de l'annonce (titre vs description).
  for (const c of (f.contradictions || [])) {
    if (c.severity === 'high') contradictions.push({ type: `ad_${c.type}`, detail: c, severity: 'high' });
  }

  // 7) Type d'offre incompatible avec un produit seul.
  const offer = f.offerType;
  if (offer === 'lot' || offer === 'part' || offer === 'accessory_only') {
    contradictions.push({ type: 'offer_type_incompatible', offerType: offer, severity: 'high' });
  } else if (offer === 'with_accessories') {
    contradictions.push({ type: 'offer_with_accessories', offerType: offer, severity: 'medium' });
  }

  // 8) État non fonctionnel : un produit « hors service / à réparer » ne partage
  // PAS la série de prix d'un produit fonctionnel (sa valeur n'est pas
  // comparable). L'annonce reste consultable, mais elle n'est pas agrégée.
  if (f.condition === 'for_parts') {
    contradictions.push({ type: 'condition_not_functional', condition: f.condition, severity: 'high' });
  }

  // ─── Décision ──────────────────────────────────────────────────────────────
  const highContradiction = contradictions.some((c) => c.severity === 'high');
  const mediumOnly = contradictions.length > 0 && !highContradiction;

  let decision;
  if (highContradiction) {
    decision = 'rejected';
  } else if ((refRelation === 'exact' || refRelation === 'partial') && score >= thresholds.REFERENCE_EXACT_FLOOR && !mediumOnly) {
    decision = 'confirmed';
  } else if (score >= thresholds.CONFIRM_MIN && !f.primaryReference && !p.reference) {
    decision = (reasons.brand && reasons.family && titleSim >= 0.6) ? 'confirmed' : 'uncertain';
  } else if (score <= thresholds.REJECT_MAX) {
    decision = 'rejected';
  } else {
    decision = 'uncertain';
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    decision,
    reasons,
    contradictions,
    referenceRelation: refRelation,
  };
}

/**
 * Choisit le meilleur candidat et recommande une action.
 *
 * `recommendation` (4 valeurs) guide la persistance :
 *   - 'link'    : associer au produit candidat (décision 'confirmed').
 *   - 'new'     : créer un produit provisoire (identité inédite) et l'associer.
 *   - 'pending' : mettre en file de rapprochement incertain (revue humaine).
 *   - 'reject'  : ne pas associer (contradiction majeure non contournable).
 *
 * @returns {Object}
 */
function decide(features, candidates, thresholds = DEFAULT_THRESHOLDS) {
  const list = Array.isArray(candidates) ? candidates : [];
  const usableRef = normalizeReference(features && features.primaryReference).length >= 2;

  if (list.length === 0) {
    // Aucun produit connu : l'annonce est-elle exploitable comme identité
    // inédite ? Oui si elle porte une référence utilisable ; sinon elle reste
    // non identifiée (jamais de produit inventé sans référence).
    return {
      decision: 'uncertain', product: null, score: 0, runnerUp: null, runnerUpScore: 0,
      ambiguous: false, evaluation: null, candidates: [],
      recommendation: usableRef ? 'new' : 'pending',
    };
  }

  const evaluations = list.map((product) => ({ product, ...scoreMatch(features, product, thresholds) }));
  evaluations.sort((a, b) => b.score - a.score);
  const best = evaluations[0];
  const second = evaluations[1] || null;
  const ambiguous = !!(second && second.decision !== 'rejected' && (best.score - second.score) < thresholds.AMBIGUITY_MARGIN);

  let decision = best.decision;
  let recommendation;
  if (best.decision === 'confirmed') {
    decision = ambiguous ? 'uncertain' : 'confirmed';
    recommendation = ambiguous ? 'pending' : 'link';
  } else if (best.decision === 'rejected') {
    const types = new Set(best.contradictions.map((c) => c.type));
    // Une référence de modèle différente (9600 vs 9600X) n'est pas un rejet :
    // c'est une identité NOUVELLE, à créer séparément.
    const modelVariantOnly = types.has('reference_model_variant') && !types.has('family_incompatible');
    // Un état non fonctionnel n'écarte QUE la comparaison de prix : l'annonce
    // reste associée au produit (elle sera isolée dans un segment « hors
    // service »). On ne crée donc pas une identité distincte.
    const nonFunctionalOnly = types.has('condition_not_functional')
      && !types.has('offer_type_incompatible') && !types.has('reference_incompatible')
      && !types.has('family_incompatible') && !types.has('units_incompatible')
      && !types.has('ad_condition_title_description') && !types.has('ad_reference_title_description');
    if (nonFunctionalOnly) {
      recommendation = 'link';
      decision = 'confirmed';
    } else if (best.contradictions.length === 0) {
      // Rejet par simple score faible, SANS aucune contradiction : l'annonce est
      // VAGUE (ex. « processeur amd »). On ne la rejette pas et on ne crée pas de
      // produit : elle part en revue manuelle (non identifiée mais conservée).
      recommendation = 'pending';
    } else if (modelVariantOnly && usableRef) recommendation = 'new';
    else if (usableRef && best.referenceRelation === 'none') recommendation = 'new';
    else recommendation = 'reject';
  } else {
    // Incertain : si l'annonce porte une référence utilisable sans aucun lien
    // avec les candidats, c'est probablement un nouveau modèle. Une annonce
    // VAGUE (sans référence exploitable) n'a pas d'identité de produit à créer
    // → file manuelle.
    recommendation = (usableRef && best.referenceRelation === 'none') ? 'new' : 'pending';
  }

  return {
    decision,
    product: best.product,
    score: best.score,
    runnerUp: second ? second.product : null,
    runnerUpScore: second ? second.score : 0,
    ambiguous,
    evaluation: best,
    recommendation,
    candidates: evaluations.map((e) => ({
      productId: e.product.id || e.product.productId || null,
      label: e.product.label || e.product.reference || null,
      reference: e.product.reference || null,
      score: e.score,
      decision: e.decision,
      referenceRelation: e.referenceRelation,
      contradictions: e.contradictions,
    })),
  };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  WEIGHTS,
  compareUnits,
  compareReferences,
  scoreMatch,
  decide,
  extractFeatures,
};
