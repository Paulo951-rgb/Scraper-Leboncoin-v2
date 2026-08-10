'use strict';

/**
 * AdStats — statistiques agrégées sur un ensemble d'annonces (sans scoring).
 *
 * Remplace l'ancien DealFinder (qui ajoutait dealTag/dealDiscountPct/hasRisk/
 * detectedRisks à chaque annonce). La nouvelle architecture IA retire tout
 * scoring heuristique : seules les statistiques de prix brutes sont conservées
 * pour l'affichage agrégé (cartes de stats, graphiques).
 *
 * N'ajoute AUCUN champ aux annonces — l'enrichissement (résumé produit,
 * verdict marché) est désormais produit par les IA 1 et 2.
 */

class AdStats {
  /**
   * Calcule les statistiques de prix d'un lot d'annonces.
   * @param {Array} ads annonces brutes (champ `price` number ou string)
   * @returns {{stats: Object|null, ads: Array}} stats + annonces inchangées
   */
  static analyze(ads) {
    if (!Array.isArray(ads) || ads.length === 0) {
      return { stats: null, ads: [] };
    }

    const validPrices = ads
      .map((a) => (typeof a.price === 'number' ? a.price : parseFloat(a.price)))
      .filter((p) => !isNaN(p) && p > 0)
      .sort((a, b) => a - b);

    if (validPrices.length === 0) {
      return { stats: null, ads };
    }

    const sum = validPrices.reduce((s, p) => s + p, 0);
    const avg = Math.round(sum / validPrices.length);
    const minPrice = validPrices[0];
    const maxPrice = validPrices[validPrices.length - 1];
    const median = validPrices[Math.floor(validPrices.length / 2)];

    return {
      stats: {
        minPrice,
        maxPrice,
        medianPrice: median,
        avgPrice: avg,
        totalAds: ads.length,
        pricedAds: validPrices.length,
      },
      ads,
    };
  }
}

module.exports = { AdStats };
