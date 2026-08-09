// =========================================================================
// FICHIER : src/main/modules/marketAnalyzer.js
// =========================================================================

'use strict';

const { summarizeAds, formatMs, redact } = require('../../utils/diagnostics');

class MarketAnalyzer {
  static async analyzeAds(ads, config = {}, onProgress) {
    if (!Array.isArray(ads) || ads.length === 0) {
      console.warn('[MarketAnalyzer] Aucune annonce à analyser (tableau vide ou non-tableau).');
      return [];
    }
    console.log(`[MarketAnalyzer] Début analyse de ${ads.length} annonce(s). ${summarizeAds(ads)}`);

    const validPrices = ads
      .map((a) => (typeof a.price === 'number' ? a.price : parseFloat(a.price)))
      .filter((p) => !isNaN(p) && p > 0)
      .sort((a, b) => a - b);

    if (validPrices.length === 0) {
      console.warn('[MarketAnalyzer] Aucun prix valide dans le dataset — analyse IA ignorée (retour des annonces brutes).');
      return ads;
    }

    const mid = Math.floor(validPrices.length / 2);
    const datasetMedian =
      validPrices.length % 2 !== 0
        ? validPrices[mid]
        : (validPrices[mid - 1] + validPrices[mid]) / 2;
    console.log(`[MarketAnalyzer] Dataset prix : ${validPrices.length} valides | min=${validPrices[0]}€ | median=${datasetMedian}€ | max=${validPrices[validPrices.length - 1]}€.`);

    const { provider = 'ollama', apiKey, model = 'llama3', ollamaUrl = 'http://127.0.0.1:11434' } = config;
    console.log(`[MarketAnalyzer] Config IA : provider=${provider} | model=${model} | ollamaUrl=${ollamaUrl} | apiKey=${redact(apiKey)}`);

    const enriched = [];
    let aiSuccessCount = 0;
    let aiFallbackCount = 0;
    const t0All = Date.now();

    for (let i = 0; i < ads.length; i++) {
      const ad = ads[i];
      const t0Ad = Date.now();

      if (onProgress) {
        onProgress({
          done: i + 1,
          total: ads.length,
          percent: Math.round(((i + 1) / ads.length) * 100),
          status: `Analyse IA (${i + 1}/${ads.length}) : ${(ad.title || '').slice(0, 30)}...`,
        });
      }

      try {
        const specs = await this.extractSpecsWithAi(ad, { provider, apiKey, model, ollamaUrl }, onProgress);
        const evaluation = this.computeMarketValue(ad, specs, datasetMedian);

        if (specs.summaryReason && specs.summaryReason.includes('Échec de l')) {
          aiFallbackCount++;
        } else {
          aiSuccessCount++;
        }

        enriched.push({
          ...ad,
          marketAnalysis: evaluation,
        });
        console.log(`[MarketAnalyzer] [${i + 1}/${ads.length}] "${(ad.title || '').slice(0, 40)}" — ${evaluation.classification} (score ${evaluation.score}) en ${formatMs(Date.now() - t0Ad)}.`);
      } catch (err) {
        aiFallbackCount++;
        console.error(`[MarketAnalyzer] [${i + 1}/${ads.length}] Erreur analyse IA sur l'annonce ${ad.id} : ${err.message}`);
        enriched.push(ad);
      }
    }

    console.log(`[MarketAnalyzer] Fin analyse : ${aiSuccessCount} réussies | ${aiFallbackCount} en fallback — durée totale ${formatMs(Date.now() - t0All)}.`);
    return enriched;
  }

  static async extractSpecsWithAi(ad, { provider, apiKey, model, ollamaUrl }, onProgress) {
    const prompt = `Tu es un expert technique en identification. Analyse cette annonce :
Titre : "${ad.title || 'Inconnu'}"
Description : "${(ad.description || 'Aucune description').slice(0, 800)}"

Ta mission :
1. Identifie le produit EXACT.
2. Évalue la gamme : "ENTREE_DE_GAMME", "MILIEU_DE_GAMME" ou "HAUT_DE_GAMME".
3. Identifie l'état réel mentionné : "NEUF", "TRES_BON_ETAT", "BON_ETAT", "ETAT_MOYEN", "HS_POUR_PIECES".
4. Évalue la qualité de la photo ("AUTHENTIQUE" si vraie photo maison, "CONSTRUCTEUR" si photo web officielle).
5. Es-tu CERTAIN de ton coup ? Si l'annonce manque d'informations cruciales ou est trop vague (ex: "vend pc portable" sans marque ni modèle), indique "isVague": true.

Réponds STRICTEMENT sous forme d'objet JSON :
{
  "identifiedProduct": "Nom précis et composants identifiés",
  "tier": "ENTREE_DE_GAMME" | "MILIEU_DE_GAMME" | "HAUT_DE_GAMME",
  "condition": "NEUF" | "TRES_BON_ETAT" | "BON_ETAT" | "ETAT_MOYEN" | "HS_POUR_PIECES",
  "photoType": "AUTHENTIQUE" | "CONSTRUCTEUR",
  "isVague": true ou false,
  "summaryReason": "Court résumé expliquant les caractéristiques principales détectées"
}`;

    let aiData = null;
    const t0Ai = Date.now();

    try {
      if (provider === 'openai' && apiKey) {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: model || 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' },
            temperature: 0.2,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          aiData = JSON.parse(data.choices[0].message.content);
          console.log(`[MarketAnalyzer] IA OpenAI OK en ${formatMs(Date.now() - t0Ai)} — produit identifié : "${(aiData.identifiedProduct || '').slice(0, 40)}".`);
        } else {
          const warnMsg = `⚠️ IA OpenAI injoignable (HTTP ${res.status}) — données par défaut appliquées.`;
          console.warn(warnMsg);
          if (onProgress) onProgress({ status: warnMsg });
        }
      } else if (provider === 'openai' && !apiKey) {
        const warnMsg = `⚠️ Provider OpenAI sélectionné mais clé API manquante — données par défaut appliquées.`;
        console.warn(warnMsg);
        if (onProgress) onProgress({ status: warnMsg });
      } else if (provider === 'ollama') {
        const res = await fetch(`${ollamaUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: model || 'llama3',
            prompt,
            format: 'json',
            stream: false,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          aiData = JSON.parse(data.response);
          console.log(`[MarketAnalyzer] IA Ollama OK en ${formatMs(Date.now() - t0Ai)} — produit identifié : "${(aiData.identifiedProduct || '').slice(0, 40)}".`);
        } else {
          const warnMsg = `⚠️ IA Ollama injoignable (HTTP ${res.status} sur ${ollamaUrl}) — données par défaut appliquées.`;
          console.warn(warnMsg);
          if (onProgress) onProgress({ status: warnMsg });
        }
      } else {
        const warnMsg = `⚠️ Provider IA inconnu "${provider}" — données par défaut appliquées.`;
        console.warn(warnMsg);
        if (onProgress) onProgress({ status: warnMsg });
      }
    } catch (err) {
      const warnMsg = `⚠️ IA injoignable (${provider}) : ${err.message} — données par défaut appliquées.`;
      console.warn(warnMsg);
      if (onProgress) onProgress({ status: warnMsg });
    }

    // 🟢 SÉCURITÉ : Si l'IA échoue, l'annonce est étiquetée comme vague à confiance FAIBLE
    return aiData || {
      identifiedProduct: ad.title || 'Produit inconnu',
      tier: 'MILIEU_DE_GAMME',
      condition: 'BON_ETAT',
      photoType: 'AUTHENTIQUE',
      isVague: true,
      summaryReason: 'Échec de l\'analyse IA. Données par défaut appliquées.',
    };
  }

  static computeMarketValue(ad, specs, datasetMedian) {
    const askingPrice = parseFloat(ad.price) || 0;

    let multiplier = 1.0;
    if (specs.tier === 'ENTREE_DE_GAMME') multiplier = 0.75;
    else if (specs.tier === 'HAUT_DE_GAMME') multiplier = 1.35;

    const estimatedAvg = Math.round(datasetMedian * multiplier) || askingPrice;
    const marketMin = Math.round(estimatedAvg * 0.85);
    const marketMax = Math.round(estimatedAvg * 1.15);

    const diffEur = Math.round(askingPrice - estimatedAvg);
    const diffPct = estimatedAvg > 0 ? Math.round(((askingPrice - estimatedAvg) / estimatedAvg) * 100) : 0;

    // 🔮 CALCULATEUR DE MARGE REVENTE & ROI
    const estResellPrice = estimatedAvg;
    const estFees = Math.round((askingPrice * 0.08) + 4.90);
    const netMarginEur = Math.round(estResellPrice - askingPrice - estFees);
    const roiPct = askingPrice > 0 ? Math.round((netMarginEur / askingPrice) * 100) : 0;

    // 🛡️ DÉTECTEUR D'ARNAQUES & FAUX PROFILS (Scam Score 0-100%)
    let scamScore = 5;
    if (diffPct <= -50) scamScore += 45; 
    if (!ad.shipping) scamScore += 15; 
    if (specs.isVague) scamScore += 20; 
    if (specs.photoType === 'CONSTRUCTEUR') scamScore += 15; 
    scamScore = Math.min(99, scamScore);

    // =========================================================================
    // 🏆 ALGORITHME COMPLET DE SCORE D'AFFAIRE (NOTATION SUR 100 POINTS)
    // =========================================================================
    let score = 0;

    // 1. Écart de Prix vs Marché (Max 30 points)
    if (diffPct <= -30) score += 30;
    else if (diffPct <= -15) score += 20;
    else if (diffPct <= 0) score += 10;
    else if (diffPct > 0) score += 0;

    // 2. Modèle et Composants (Max 20 points)
    if (specs.tier === 'HAUT_DE_GAMME') score += 20;
    else if (specs.tier === 'MILIEU_DE_GAMME') score += 12;
    else if (specs.tier === 'ENTREE_DE_GAMME') score += 5;

    // 3. État du produit (Max 15 points)
    if (specs.condition === 'NEUF' || specs.condition === 'TRES_BON_ETAT') score += 15;
    else if (specs.condition === 'BON_ETAT') score += 10;
    else if (specs.condition === 'ETAT_MOYEN') score += 5;

    // 4. Estimation Comparée (Max 20 points)
    if (!specs.isVague) score += 20; // 20 points si l'IA est sûre du modèle et de ses caractéristiques

    // 5. Marge Potentielle (Max 10 points)
    if (netMarginEur > 40 && roiPct >= 35) score += 10;
    else if (netMarginEur > 15 && roiPct >= 15) score += 5;

    // 6. Confiance de l'Analyse (Max 5 points)
    if (!specs.isVague && specs.photoType === 'AUTHENTIQUE') score += 5;

    // 7. MALUS de Risques (Malus immédiat de 20 points)
    const fullText = `${ad.title || ''} ${ad.description || ''}`.toLowerCase();
    const hasRisk = specs.condition === 'HS_POUR_PIECES' || ad.hasRisk;
    if (hasRisk) {
      score -= 20;
    }

    // Assurer que le score reste dans les bornes [0 - 100]
    score = Math.max(0, Math.min(100, score));

    // Attribution dynamique de l'évaluation selon le score réel
    let classification = 'Prix correct';
    let badgeClass = 'tag-deal-normal';

    if (score >= 80) {
      classification = 'Très bonne affaire';
      badgeClass = 'tag-deal-super';
    } else if (score >= 60) {
      classification = 'Bonne affaire';
      badgeClass = 'tag-deal-good';
    } else if (score < 35) {
      classification = 'Trop cher';
      badgeClass = 'tag-deal-superhigh';
    } else if (score < 50) {
      classification = 'Légèrement cher';
      badgeClass = 'tag-deal-high';
    }

    const summary = `${specs.identifiedProduct || ad.title}. Score d'affaire : ${score}/100 (${classification}). Prix demandé : ${askingPrice} € vs estimation d'occasion de ${estimatedAvg} € (marge de revente de ${netMarginEur} €). ${specs.summaryReason || ''}`;

    return {
      productName: specs.identifiedProduct || ad.title,
      classification,
      badgeClass,
      askingPrice,
      marketMin,
      marketMax,
      marketAvg: estimatedAvg,
      diffEur,
      diffPct,
      confidence: specs.isVague ? 'Faible' : 'Élevé',
      summary,
      netMarginEur,
      roiPct,
      scamScore,
      photoType: specs.photoType || 'AUTHENTIQUE',
      score, // Ajout du score sur 100
    };
  }
}

module.exports = { MarketAnalyzer };