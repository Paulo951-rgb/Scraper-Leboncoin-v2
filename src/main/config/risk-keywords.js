'use strict';

/**
 * Mots-clés signalant un risque (annonce défectueuse, HS, pour pièces…).
 * Utilisés par le service d'analyse DealFinder pour détacher la logique métier
 * de la configuration des chemins (constants.js).
 */
const RISK_KEYWORDS = [
  'hs', 'pour pièces', 'pour pieces', 'panne', 'non testé', 'non teste',
  'à réparer', 'a reparer', 'cassé', 'casse', 'sans chargeur', 'fissuré',
  'incomplet', 'défectueux', 'defectueux',
];

module.exports = { RISK_KEYWORDS };
