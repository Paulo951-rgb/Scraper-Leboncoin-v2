'use strict';

/**
 * productRegistry — création / résolution des produits CANONIQUES et
 * GÉNÉRATION DE CANDIDATS pour le rapprochement.
 *
 * Module de LOGIQUE (pas d'UI, pas d'IA). Il s'appuie sur la couche de
 * persistance (priceHistoryDb) mais reste testable : les fonctions pures de
 * construction de clé / candidats sont exportées séparément.
 *
 * Aucun produit n'est créé « confirmé » sur la simple présence d'un mot : un
 * produit naît PROVISOIRE (status='provisional') et n'est confirmé que par une
 * décision de rapprochement ou une correction manuelle.
 */

const { normalizeText, normalizeReference } = require('./normalizeText');

/**
 * Construit la clé canonique d'un produit à partir de ses caractéristiques.
 * Deux annonces dont la référence ET la famille concordent partagent la clé.
 * Les unités DISCRIMINANTES (capacité) font partie de la clé : 8 Go ≠ 16 Go.
 * @param {Object} features
 * @returns {string}
 */
function buildCanonicalKey(features) {
  const f = features || {};
  const family = f.family || 'unknown';
  const ref = normalizeReference(f.primaryReference);
  const brand = f.brand ? normalizeText(f.brand) : '';
  const parts = [family];
  if (ref) parts.push(`ref:${ref}`);
  if (brand) parts.push(`brand:${brand}`);
  // Capacité : incluse seulement si elle est réellement discriminante.
  const u = f.units || {};
  const cap = u.capacity_gb || u.capacity_tb || u.capacity_mb;
  if (cap && cap.value != null) parts.push(`cap:${cap.unit}:${cap.value}`);
  return parts.join('|');
}

/**
 * Libellé lisible d'un produit (pour l'UI). Jamais inventé : construit à partir
 * des seules données disponibles.
 * @param {Object} features
 * @returns {string}
 */
function buildLabel(features) {
  const f = features || {};
  const bits = [];
  if (f.brand) bits.push(titleCaseBrand(f.brand));
  if (f.familyLabel) bits.push(f.familyLabel);
  if (f.primaryReference) bits.push(f.primaryReference);
  const cap = (f.units && (f.units.capacity_gb || f.units.capacity_tb));
  if (cap) bits.push(`${cap.value} ${cap.unit}`);
  if (bits.length === 0) {
    // Aucune caractéristique exploitable : on n'invente rien, on marque l'état.
    return 'Produit non identifié';
  }
  return bits.join(' ');
}

function titleCaseBrand(brand) {
  const s = String(brand);
  const known = { amd: 'AMD', nvidia: 'NVIDIA', msi: 'MSI', asus: 'ASUS', hp: 'HP', lg: 'LG', wd: 'WD' };
  if (known[s.toLowerCase()]) return known[s.toLowerCase()];
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Construit les caractéristiques d'un produit à partir des features d'une
 * annonce (utilisé à la création d'un produit provisoire).
 * @param {Object} features
 * @returns {Object}
 */
function productFromFeatures(features) {
  const f = features || {};
  return {
    canonicalKey: buildCanonicalKey(f),
    reference: f.primaryReference || null,
    brand: f.brand || null,
    family: f.family || null,
    label: buildLabel(f),
    units: f.units || {},
    titleTokens: f.titleTokens || [],
    status: 'provisional',
    rulesVersion: 1,
    provenance: 'observed',
  };
}

/**
 * Convertit une ligne `products` de la base en objet exploitable par le moteur.
 * @param {Object} row
 * @returns {Object}
 */
function rowToProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    reference: row.reference,
    brand: row.brand,
    family: row.family,
    label: row.label,
    units: safeParse(row.units_json, {}),
    titleTokens: safeParse(row.title_tokens, []),
    status: row.status,
    rulesVersion: row.rules_version,
  };
}

function safeParse(s, fallback) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/**
 * Génère des CANDIDATS à partir d'un index de produits (Map canonicalKey →
 * produit) et des features d'une annonce. Mécanisme d'indexation déterministe :
 *   1. correspondance de référence normalisée (exacte) ;
 *   2. correspondance de référence partielle (l'une contient l'autre) ;
 *   3. correspondance de famille + marque ;
 *   4. correspondance de famille seule (repli, limité).
 * On ne compare JAMAIS naïvement l'annonce à tous les produits : l'index par
 * référence restreint l'ensemble des candidats.
 *
 * @param {Object} features
 * @param {{byReference: Map, byFamily: Map, all: Array}} index
 * @param {number} [maxCandidates]
 * @returns {Array<Object>} produits candidats
 */
function generateCandidates(features, index, maxCandidates = 12) {
  const f = features || {};
  const idx = index || { byReference: new Map(), byFamily: new Map(), all: [] };
  const out = new Map(); // id → produit (dédup)

  const add = (p) => { if (p && p.id != null && !out.has(p.id)) out.set(p.id, p); };

  const ref = normalizeReference(f.primaryReference);
  if (ref) {
    // 1) référence exacte
    for (const p of (idx.byReference.get(ref) || [])) add(p);
    // 2) référence partielle : parcours des références connues contenant/étant
    //    contenues par la référence de l'annonce (borné).
    if (out.size < maxCandidates) {
      for (const [k, list] of idx.byReference.entries()) {
        if (k === ref) continue;
        if (k.length >= 3 && (k.includes(ref) || ref.includes(k))) {
          for (const p of list) add(p);
          if (out.size >= maxCandidates) break;
        }
      }
    }
  }

  // 3) famille + marque (quand aucune référence exploitable, ou en complément).
  if (out.size < maxCandidates && f.family) {
    const famList = idx.byFamily.get(f.family) || [];
    const brand = f.brand ? normalizeText(f.brand) : null;
    for (const p of famList) {
      if (out.size >= maxCandidates) break;
      if (!brand || !p.brand || normalizeText(p.brand) === brand) add(p);
    }
    // 4) famille seule (repli) si toujours peu de candidats.
    if (out.size === 0) {
      for (const p of famList) { if (out.size >= maxCandidates) break; add(p); }
    }
  }

  return [...out.values()].slice(0, maxCandidates);
}

/**
 * Construit un index de candidats à partir d'une liste de lignes `products`.
 * @param {Array<Object>} rows
 * @returns {{byReference: Map, byFamily: Map, all: Array}}
 */
function buildIndex(rows) {
  const byReference = new Map();
  const byFamily = new Map();
  const all = [];
  for (const row of (rows || [])) {
    const p = rowToProduct(row);
    if (!p) continue;
    all.push(p);
    const ref = normalizeReference(p.reference);
    if (ref) {
      if (!byReference.has(ref)) byReference.set(ref, []);
      byReference.get(ref).push(p);
    }
    if (p.family) {
      if (!byFamily.has(p.family)) byFamily.set(p.family, []);
      byFamily.get(p.family).push(p);
    }
  }
  return { byReference, byFamily, all };
}

module.exports = {
  buildCanonicalKey,
  buildLabel,
  productFromFeatures,
  rowToProduct,
  generateCandidates,
  buildIndex,
  titleCaseBrand,
};
