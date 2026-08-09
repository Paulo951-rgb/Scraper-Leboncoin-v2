'use strict';

const { formatBytes, formatMs, redact, summarizeAds, truncate } = require('../../utils/diagnostics');
const { sleep } = require('../../utils/helpers');

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

    console.log(`[GlobalAnalyzer] Début — preset=${presetKey} | model=${geminiModel} | apiKey=${redact(geminiApiKey)} | ${summarizeAds(ads)}`);

    if (!geminiApiKey) throw new Error('Clé API Gemini manquante.');
    if (!Array.isArray(ads) || ads.length === 0) {
      console.warn('[GlobalAnalyzer] Dataset vide — retour de la structure vide par défaut.');
      return { summaryKpi: { totalAnalyzed: 0, bestDealTitle: '-', totalPotentialProfitEur: 0, overview: 'Aucune annonce à analyser.' }, topRanking: [] };
    }

    if (onProgress) onProgress({ percent: 10, status: 'Préparation du dataset pour Gemini...' });

    const presetInstruction = PRESETS[presetKey] || PRESETS.TOP_DEALS;
    const focusInstruction = presetKey === 'CUSTOM' && customInstruction
      ? customInstruction
      : presetInstruction;
    console.log(`[GlobalAnalyzer] Instruction focus : ${truncate(focusInstruction, 100)}`);

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

    const promptSize = Buffer.byteLength(prompt, 'utf8');
    console.log(`[GlobalAnalyzer] Prompt construit : ${formatBytes(promptSize)} (${compactAds.length} annonces compactées).`);

    if (onProgress) onProgress({ percent: 30, status: 'Appel à Google Gemini en cours...' });

    let aiData;
    const t0Gemini = Date.now();
    try {
      aiData = await this._callGeminiWithRetry(prompt, geminiApiKey, geminiModel, onProgress);
      console.log(`[GlobalAnalyzer] Réponse Gemini reçue en ${formatMs(Date.now() - t0Gemini)}.`);
    } catch (err) {
      console.error(`[GlobalAnalyzer] Échec appel Gemini après ${formatMs(Date.now() - t0Gemini)} : ${err.message}`);
      throw err;
    }

    if (onProgress) onProgress({ percent: 80, status: 'Mise en forme du rapport...' });

    // On s'assure de renvoyer une structure cohérente avec renderGlobalReport.
    const summaryKpi = aiData.summaryKpi || {};
    const topRanking = Array.isArray(aiData.topRanking) ? aiData.topRanking : [];

    // Garantit que totalAnalyzed reflète bien le dataset réel si l'IA l'omet.
    if (summaryKpi.totalAnalyzed == null) summaryKpi.totalAnalyzed = ads.length;

    console.log(`[GlobalAnalyzer] Rapport final : ${topRanking.length} entrée(s) dans le classement | bestDeal="${truncate(summaryKpi.bestDealTitle, 40)}" | totalAnalyzed=${summaryKpi.totalAnalyzed}.`);

    if (onProgress) onProgress({ percent: 100, status: 'Analyse globale terminée.' });

    return { summaryKpi, topRanking };
  }

  static async _callGeminiWithRetry(prompt, apiKey, model, onProgress, maxRetries = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this._callGemini(prompt, apiKey, model);
      } catch (err) {
        lastErr = err;
        // Retry uniquement sur 429 (quota) ou 503 (service unavailable)
        const isRetryable = err.message.includes('429') || err.message.includes('503');
        if (!isRetryable || attempt >= maxRetries) throw err;

        // Extraction du délai suggéré depuis le message Gemini
        const retryMatch = err.message.match(/retry in ([\d.]+)s/i);
        const waitSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : 15 * attempt;
        const waitMs = waitSec * 1000;

        const msg = `⏳ Quota Gemini atteint (429). Nouvelle tentative ${attempt + 1}/${maxRetries} dans ${waitSec}s...`;
        console.warn(`[GlobalAnalyzer] ${msg}`);
        if (onProgress) onProgress({ percent: 30, status: msg });

        await sleep(waitMs);
      }
    }
    throw lastErr;
  }

  static async _callGemini(prompt, apiKey, model) {
    const url = `${GEMINI_ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    console.log(`[GlobalAnalyzer] Appel Gemini : ${GEMINI_ENDPOINT}/${model}:generateContent?key=${redact(apiKey)}`);

    const t0Fetch = Date.now();
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
      console.error(`[GlobalAnalyzer] Gemini HTTP ${res.status} : ${truncate(detail, 200)}`);

      // Messages d'erreur plus clairs selon le code HTTP
      if (res.status === 429) {
        // Extraction du délai de retry depuis le message
        const retryMatch = detail.match(/retry in ([\d.]+)s/i);
        const waitSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : '?';
        throw new Error(`Quota Gemini dépassé (429). ${detail.slice(0, 300)}${retryMatch ? ` — Réessayez dans ~${waitSec}s.` : ''} Astuce : le plan gratuit Gemini a une limite de requêtes/minute. Attendez ou passez au plan payant.`);
      }
      if (res.status === 400) {
        throw new Error(`Requête Gemini invalide (400) : ${truncate(detail, 200)}. Vérifiez le modèle sélectionné (${model}).`);
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Clé API Gemini invalide ou non autorisée (${res.status}). Vérifiez votre clé API dans les Paramètres.`);
      }
      throw new Error(`Gemini HTTP ${res.status} : ${truncate(detail, 200) || 'réponse non lisible'}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log(`[GlobalAnalyzer] Réponse HTTP ${res.status} reçue en ${formatMs(Date.now() - t0Fetch)} — contenu ${text ? formatBytes(Buffer.byteLength(text, 'utf8')) : '(vide)'}.`);

    if (!text) {
      console.error('[GlobalAnalyzer] Réponse Gemini vide — candidats/parts manquants.', JSON.stringify(data?.candidates?.[0] || {}).slice(0, 200));
      throw new Error('Réponse Gemini vide (aucun contenu généré).');
    }

    try {
      const parsed = JSON.parse(text);
      console.log(`[GlobalAnalyzer] JSON parsé avec succès — clés : ${Object.keys(parsed).join(', ')}.`);
      return parsed;
    } catch (err) {
      console.error(`[GlobalAnalyzer] Échec parsing JSON Gemini : ${err.message} — début du texte : ${truncate(text, 200)}`);
      throw new Error(`Réponse Gemini non-JSON : ${err.message}`);
    }
  }
}

module.exports = { GlobalAnalyzer };
