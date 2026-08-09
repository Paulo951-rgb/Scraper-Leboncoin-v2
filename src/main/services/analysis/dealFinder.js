// =========================================================================
// FICHIER : src/main/modules/dealFinder.js
// =========================================================================

'use strict';

// Mots-clés de risque centralisés dans config/risk-keywords.js (logique métier isolée)
const { RISK_KEYWORDS } = require('../../config/risk-keywords');

class DealFinder {
  static analyze(ads) {
    if (!Array.isArray(ads) || ads.length === 0) {
      return { stats: null, enrichedAds: [] };
    }

    const validPrices = ads
      .map((a) => (typeof a.price === 'number' ? a.price : parseFloat(a.price)))
      .filter((p) => !isNaN(p) && p > 0)
      .sort((a, b) => a - b);

    if (validPrices.length === 0) {
      return { stats: null, enrichedAds: ads };
    }

    // Percentiles pour seuils dynamiques
    const q20 = validPrices[Math.floor(validPrices.length * 0.2)];
    const q80 = validPrices[Math.floor(validPrices.length * 0.8)];
    const minPrice = validPrices[0];
    const maxPrice = validPrices[validPrices.length - 1];

    let goodDealsCount = 0;
    let riskCount = 0;

    const enrichedAds = ads.map((ad) => {
      const price = typeof ad.price === 'number' ? ad.price : parseFloat(ad.price);
      let dealTag = 'NORMAL';
      let dealDiscountPct = 0;

      if (!isNaN(price) && price > 0) {
        if (price <= q20) {
          dealTag = 'GOOD';
          dealDiscountPct = Math.round(((q20 - price) / q20) * 100);
          goodDealsCount++;
        } else if (price >= q80) {
          dealTag = 'HIGH';
          dealDiscountPct = Math.round(((price - q80) / q80) * 100);
        }
      }

      const fullText = `${ad.title || ''} ${ad.description || ''}`.toLowerCase();
      const detectedRisks = RISK_KEYWORDS.filter((k) => fullText.includes(k));
      const hasRisk = detectedRisks.length > 0;
      if (hasRisk) riskCount++;

      return {
        ...ad,
        dealTag,
        dealDiscountPct,
        hasRisk,
        detectedRisks,
      };
    });

    return {
      stats: {
        minPrice,
        maxPrice,
        totalAds: ads.length,
        goodDealsCount,
        riskCount,
      },
      enrichedAds,
    };
  }
}

module.exports = { DealFinder };