'use strict';

/**
 * normalizeText — normalisation DÉTERMINISTE de texte pour le moteur
 * d'identification de produits (« Évolution des prix »).
 *
 * Module PUR : aucune dépendance (pas d'Electron, pas d'IA, pas de réseau),
 * donc testable et importable par n'importe quelle couche.
 *
 * PRINCIPE FONDAMENTAL : la normalisation ne doit JAMAIS effacer les chiffres,
 * suffixes ou unités qui distinguent deux modèles (9600 ≠ 9600X, 8 Go ≠ 16 Go,
 * RTX 3060 ≠ RTX 3060 Ti). On ne fait donc que replier la casse, les accents
 * (pour la recherche de mots) et les variantes typographiques ; les chiffres,
 * lettres et suffixes sont préservés. Les données ORIGINALES ne sont jamais
 * modifiées par ce module : il produit une vue dérivée.
 */

// Repli d'accents : la distinction accent/absence d'accent est sans intérêt
// pour identifier un produit (« écran » ≡ « ecran »). Les chiffres et lettres
// ne sont pas touchés.
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Replie les accents et variantes typographiques, sans changer la longueur
 * sémantique (les chiffres/suffixes sont conservés).
 * @param {string} s
 * @returns {string}
 */
function foldAccents(s) {
  return String(s).normalize('NFD').replace(COMBINING_MARKS, '');
}

/**
 * Normalise un texte libre en une suite de « mots » séparés par une espace
 * unique : minuscules, sans accent, ponctuation et séparateurs ramenés à des
 * espaces. Reproductible (même entrée → même sortie).
 *
 * Exemples :
 *   normalizeText('AMD Ryzen 5 9600X (neuf)') → 'amd ryzen 5 9600x neuf'
 *   normalizeText('R5-9600X_v2')              → 'r5 9600x v2'
 *
 * @param {*} input
 * @returns {string}
 */
function normalizeText(input) {
  if (input == null) return '';
  let s = foldAccents(input).toLowerCase();
  // Ligatures françaises (œ/æ) : NFD ne les décompose pas. On les développe
  // pour que « cœur » ≡ « coeur » (sans quoi elles deviendraient des
  // séparateurs et casseraient le mot).
  s = s.replace(/\u0153/g, 'oe').replace(/\u00e6/g, 'ae');
  // Tirets et variantes typographiques Unicode → tiret ASCII, puis espace.
  s = s.replace(/[\u2010-\u2015\u2212]/g, '-');
  // Apostrophes typographiques → apostrophe simple (qui deviendra un espace).
  s = s.replace(/[\u2018\u2019\u02bc\u00b4`]/g, "'");
  // Guillemets → espace.
  s = s.replace(/[\u201c\u201d\u00ab\u00bb"]/g, ' ');
  // Tout ce qui n'est pas alphanumérique devient séparateur.
  s = s.replace(/[^a-z0-9]+/g, ' ');
  return s.trim().replace(/\s+/g, ' ');
}

/**
 * Découpe un texte en tokens normalisés.
 * @param {*} input
 * @returns {string[]}
 */
function tokenize(input) {
  const n = normalizeText(input);
  return n === '' ? [] : n.split(' ');
}

/**
 * Normalise une RÉFÉRENCE : conserve uniquement les caractères alphanumériques,
 * en majuscules. Les séparateurs (tiret, espace, underscore, point, slash) sont
 * retirés car ils varient selon les vendeurs sans changer la référence :
 *   'R5-9600X' ≡ 'R5 9600X' ≡ 'r5_9600x' → 'R59600X'
 *
 * ATTENTION : ne pas confondre avec normalizeText (qui sépare par espaces).
 * normalizeReference sert à comparer des références, pas à tokeniser.
 * @param {*} input
 * @returns {string} chaîne alphanumérique majuscule ('' si rien)
 */
function normalizeReference(input) {
  if (input == null) return '';
  return foldAccents(input).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Similarité de Jaccard sur deux ensembles de tokens.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number} 0..1
 */
function jaccard(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Similarité de Dice (coefficient de Sørensen–Dice) sur deux ensembles de
 * tokens — plus tolérante que Jaccard quand les titres ont des longueurs
 * très différentes (titre court vs titre long).
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number} 0..1
 */
function dice(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return (2 * inter) / (sa.size + sb.size);
}

module.exports = {
  foldAccents,
  normalizeText,
  tokenize,
  normalizeReference,
  jaccard,
  dice,
};
