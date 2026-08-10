'use strict';

/**
 * Mots-clés signalant un risque (annonce défectueuse, HS, pour pièces…).
 * Conservés pour référence et tests ; le nouveau système IA (adAnalyzer)
 * détecte l'état et les défauts via l'analyse texte+vision plutôt que par
 * correspondance de mots-clés.
 */
const RISK_KEYWORDS = [
  'hs', 'pour pièces', 'pour pieces', 'panne', 'non testé', 'non teste',
  'à réparer', 'a reparer', 'cassé', 'casse', 'sans chargeur', 'fissuré',
  'incomplet', 'défectueux', 'defectueux',
];

module.exports = { RISK_KEYWORDS };
