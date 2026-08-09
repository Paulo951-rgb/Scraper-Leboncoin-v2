// =========================================================================
// FICHIER : src/main/modules/globalAnalyzer.js
// Analyse globale d'un dataset d'annonces via Google Gemini.
// =========================================================================

'use strict';

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

const PRESETS = {
  TOP_DEALS: 'Identifie le Top 20 des meilleures affaires (rapport qualité/prix le plus avantageux, sans risque d\'arnaque).',
  RESELL_FLIP: 'Spécial achat-revente : classe les 20 annonces offrant la meilleure marge nette de revente potentielle.',
  PERF_PRICE: 'Rapport performance/prix maximal : classe les 20 annonces au meilleur rapport capacité/prix.',
};

class GlobalAnalyzer {
  /**
   * Analyse un dataset complet d'annonces via Gemini.
   * @param {Array} ads Liste des annonces (issues du pipeline/marketAnalyzer).
   * @param {Object} options { presetKey, customInstruction, geminiApiKey, geminiModel }
   * @param {Function} onProgress Callback de progression optionnel.
   * @returns {Promise<{ summaryKpi: Object, topRanking: Array }>}
   */
  static async analyze(ads, options = {}, onProgress) {
    const {
      presetKey = 'TOP_DEALS',
      customInstruction,
      geminiApiKey,
      geminiModel = 'gemini-2.0-flash',
    } = options;

    if (!geminiApiKey) throw new Error('Clé API Gemini manquante.');
    if (!Array.isArray(ads) || ads.length === 0) {
      return { summaryKpi: { totalAnalyzed: 0, bestDealTitle: '-', totalPotentialProfitEur: 0, overview: 'Aucune annonce à analyser.' }, topRanking: [] };
    }

    if (onProgress) onProgress({ percent: 10, status: 'Préparation du dataset pour Gemini...' });

    const presetInstruction = PRESETS[presetKey] || PRESETS.TOP_DEALS;
    const focusInstruction = presetKey === 'CUSTOM' && customInstruction
      ? customInstruction
      : presetInstruction;

    // On transmet un résumé compact de chaque annonce (titre, prix, estimation marché, marge, etc.).
    const compactAds = ads.map((a, i) => {
      const ma = a.marketAnalysis || {};
      return {
        index: i + 1,
        id: a.id,
        title: a.title,
        price: a.price,
        city: a.city,
        url: a.url,
        description: (a.description || '').slice(0, 300),
        marketAvg: ma.marketAvg,
        diffPct: ma.diffPct,
        netMarginEur: ma.netMarginEur,
        roiPct: ma.roiPct,
        classification: ma.classification,
        scamScore: ma.scamScore,
        score: ma.score,
        productName: ma.productName,
      };
    });

    const prompt = `Tu es un expert en analyse de marché de biens d'occasion.
Voici un dataset de ${ads.length} annonces Leboncoin (format JSON compact) :

${JSON.stringify(compactAds)}

Mission : ${focusInstruction}

Réponds STRICTEMENT et UNIQUEMENT avec un objet JSON valide (sans texte autour, sans markdown) de cette forme exacte :
{
  "summaryKpi": {
    "totalAnalyzed": nombre,
    "bestDealTitle": "titre de la meilleure affaire",
    "totalPotentialProfitEur": nombre (somme des marges nettes des opportunités retenues),
    "overview": "Synthèse stratégique en 2-3 phrases (marché, tendances, alertes)"
  },
  "topRanking": [
    {
      "rank": 1,
      "identifiedProduct": "Nom précis du produit",
      "askingPrice": nombre,
      "estimatedMarketValue": nombre,
      "estimatedNetProfitEur": nombre,
      "dealDiscountPct": nombre,
      "whyItIsTop": "Raison courte (1-2 phrases) expliquant pourquoi cette annonce est bien classée"
    }
  ]
}

Le topRanking doit contenir au maximum 20 entrées, triées de la meilleure à la moins bonne. Les prix et marges sont en euros entiers.`;

    if (onProgress) onProgress({ percent: 30, status: 'Appel à Google Gemini en cours...' });

    let aiData;
    try {
      aiData = await this._callGemini(prompt, geminiApiKey, geminiModel);
    } catch (err) {
      throw new Error(`Échec de l'appel Gemini : ${err.message}`);
    }

    if (onProgress) onProgress({ percent: 80, status: 'Mise en forme du rapport...' });

    // On s'assure de renvoyer une structure cohérente avec renderGlobalReport.
    const summaryKpi = aiData.summaryKpi || {};
    const topRanking = Array.isArray(aiData.topRanking) ? aiData.topRanking : [];

    // Garantit que totalAnalyzed reflète bien le dataset réel si l'IA l'omet.
    if (summaryKpi.totalAnalyzed == null) summaryKpi.totalAnalyzed = ads.length;

    if (onProgress) onProgress({ percent: 100, status: 'Analyse globale terminée.' });

    return { summaryKpi, topRanking };
  }

  static async _callGemini(prompt, apiKey, model) {
    const url = `${GEMINI_ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          response_mime_type: 'application/json',
        },
      }),
    });

    if (!res.ok) {
      let detail = '';
      try {
        const errBody = await res.json();
        detail = errBody?.error?.message || JSON.stringify(errBody);
      } catch {
        detail = await res.text().catch(() => '');
      }
      throw new Error(`Gemini HTTP ${res.status} : ${detail || 'réponse non lisible'}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) throw new Error('Réponse Gemini vide (aucun contenu généré).');

    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`Réponse Gemini non-JSON : ${err.message}`);
    }
  }
}

module.exports = { GlobalAnalyzer };
