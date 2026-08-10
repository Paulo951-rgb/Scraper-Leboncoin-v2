'use strict';

const { summarizeAds, formatMs, redact } = require('../../utils/diagnostics');
const aiCache = require('./aiCache');

class MarketAnalyzer {
  static async analyzeAds(ads, config = {}, onProgress) {
    const log = config._log || ((msg, level = 'debug') => console.log(`[MarketAnalyzer] ${msg}`));
    const useCache = config.useCache !== false; // cache activé par défaut

    if (!Array.isArray(ads) || ads.length === 0) {
      log('Aucune annonce à analyser (tableau vide ou non-tableau).', 'warn');
      return [];
    }
    log(`Début analyse de ${ads.length} annonce(s). ${summarizeAds(ads)}`, 'info');

    const validPrices = ads
      .map((a) => (typeof a.price === 'number' ? a.price : parseFloat(a.price)))
      .filter((p) => !isNaN(p) && p > 0)
      .sort((a, b) => a - b);

    if (validPrices.length === 0) {
      log('Aucun prix valide dans le dataset — analyse IA ignorée (retour des annonces brutes).', 'warn');
      return ads;
    }

    const mid = Math.floor(validPrices.length / 2);
    const datasetMedian =
      validPrices.length % 2 !== 0
        ? validPrices[mid]
        : (validPrices[mid - 1] + validPrices[mid]) / 2;
    log(`Dataset prix : ${validPrices.length} valides | min=${validPrices[0]}€ | median=${datasetMedian}€ | max=${validPrices[validPrices.length - 1]}€.`, 'debug');

    const { provider = 'ollama', apiKey, model = 'llama3', ollamaUrl = 'http://127.0.0.1:11434', concurrency = 5 } = config;
    log(`Config IA : provider=${provider} | model=${model} | ollamaUrl=${ollamaUrl} | apiKey=${redact(apiKey)} | concurrency=${concurrency}`, 'debug');

    const enriched = new Array(ads.length);
    let aiSuccessCount = 0;
    let aiFallbackCount = 0;
    const t0All = Date.now();

    const cacheStatsBefore = useCache ? aiCache.stats() : { entries: 0 };
    if (useCache) log(`Cache IA : ${cacheStatsBefore.entries} entrée(s) en cache.`, 'debug');

    for (let i = 0; i < ads.length; i += concurrency) {
      const batch = ads.slice(i, i + concurrency);

      // Séparation cache miss / cache hit
      const toAnalyze = [];
      const cachedResults = [];
      batch.forEach((ad, j) => {
        const idx = i + j;
        if (useCache && ad.id) {
          const cached = aiCache.get(ad.id);
          if (cached) {
            cachedResults.push({ idx, ad, specs: cached.specs });
            return;
          }
        }
        toAnalyze.push({ idx, ad });
      });

      if (cachedResults.length > 0) {
        log(`Batch IA ${Math.floor(i / concurrency) + 1} : ${cachedResults.length} cache hit(s), ${toAnalyze.length} à analyser`, 'debug');
      }

      // Analyse IA uniquement pour les cache miss
      const results = await Promise.all(
        toAnalyze.map(({ idx, ad }) => {
          const t0Ad = Date.now();
          return this.extractSpecsWithAi(ad, { provider, apiKey, model, ollamaUrl })
            .then((specs) => {
              if (useCache && ad.id) aiCache.set(ad.id, specs);
              log(`[${idx + 1}/${ads.length}] "${(ad.title || '').slice(0, 50)}" (${ad.price}€) → ${this.computeMarketValue(ad, specs, datasetMedian).classification} — ${formatMs(Date.now() - t0Ad)}`, 'info');
              return { idx, ad, specs };
            })
            .catch((err) => {
              log(`[${idx + 1}/${ads.length}] Erreur analyse IA sur "${(ad.title || ad.id).slice(0, 50)}" : ${err.message}`, 'error');
              return { idx, ad, specs: null };
            });
        })
      );

      // Fusion cache hits + cache misses
      for (const { idx, ad, specs } of [...cachedResults, ...results]) {
        if (specs) {
          const evaluation = this.computeMarketValue(ad, specs, datasetMedian);
          if (specs.summaryReason && specs.summaryReason.includes('Échec de l')) {
            aiFallbackCount++;
          } else {
            aiSuccessCount++;
          }
          enriched[idx] = { ...ad, marketAnalysis: evaluation };
        } else {
          aiFallbackCount++;
          enriched[idx] = ad;
        }
      }

      const done = Math.min(i + concurrency, ads.length);
      if (onProgress) {
        onProgress({
          done,
          total: ads.length,
          percent: Math.round((done / ads.length) * 100),
          status: `Analyse IA (${done}/${ads.length}) — batch parallèle x${concurrency}`,
        });
      }
    }

    log(`Fin analyse : ${aiSuccessCount} réussies | ${aiFallbackCount} en fallback — durée totale ${formatMs(Date.now() - t0All)}.`, 'info');
    return enriched;
  }

  static async extractSpecsWithAi(ad, { provider, apiKey, model, ollamaUrl }) {
    const prompt = `Expert technique. Analyse cette annonce Leboncoin et réponds en JSON strict.

Titre: "${ad.title || 'Inconnu'}"
Description: "${(ad.description || 'Aucune').slice(0, 500)}"
Prix: ${ad.price || '?'}€

JSON attendu:
{"identifiedProduct":"nom précis","tier":"ENTREE_DE_GAMME|MILIEU_DE_GAMME|HAUT_DE_GAMME","condition":"NEUF|TRES_BON_ETAT|BON_ETAT|ETAT_MOYEN|HS_POUR_PIECES","photoType":"AUTHENTIQUE|CONSTRUCTEUR","isVague":true/false,"summaryReason":"résumé court"}`;

    let aiData = null;
    const t0Ai = Date.now();

    // Timeout : sans ça, un serveur IA injoignable pouvait bloquer l'analyse
    // d'une annonce indéfiniment (fetch natif n'a pas d'option timeout).
    const mkTimeout = (ms = 60000) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      return { signal: controller.signal, done: () => clearTimeout(timer) };
    };

    try {
      if (provider === 'openai' && apiKey) {
        const to = mkTimeout(60000);
        try {
          const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: model || 'gpt-4o-mini',
              messages: [{ role: 'user', content: prompt }],
              response_format: { type: 'json_object' },
              temperature: 0.2,
            }),
            signal: to.signal,
          });
          if (res.ok) {
            const data = await res.json();
            aiData = JSON.parse(data.choices[0].message.content);
            console.log(`[MarketAnalyzer] IA OpenAI OK en ${formatMs(Date.now() - t0Ai)} — produit identifié : "${(aiData.identifiedProduct || '').slice(0, 40)}".`);
          } else {
            console.warn(`⚠️ IA OpenAI injoignable (HTTP ${res.status}) — données par défaut appliquées.`);
          }
        } finally { to.done(); }
      } else if (provider === 'openai' && !apiKey) {
        console.warn(`⚠️ Provider OpenAI sélectionné mais clé API manquante — données par défaut appliquées.`);
      } else if (provider === 'ollama') {
        const to = mkTimeout(120000);
        try {
          const res = await fetch(`${ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: model || 'llama3',
              prompt,
              format: 'json',
              stream: false,
            }),
            signal: to.signal,
          });
          if (res.ok) {
            const data = await res.json();
            aiData = JSON.parse(data.response);
            console.log(`[MarketAnalyzer] IA Ollama OK en ${formatMs(Date.now() - t0Ai)} — produit identifié : "${(aiData.identifiedProduct || '').slice(0, 40)}".`);
          } else {
            console.warn(`⚠️ IA Ollama injoignable (HTTP ${res.status} sur ${ollamaUrl}) — données par défaut appliquées.`);
          }
        } finally { to.done(); }
      } else {
        console.warn(`⚠️ Provider IA inconnu "${provider}" — données par défaut appliquées.`);
      }
    } catch (err) {
      console.warn(`⚠️ IA injoignable (${provider}) : ${err.message} — données par défaut appliquées.`);
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

  /**
   * Recalcule le score d'une annonce en intégrant les résultats d'analyse visuelle.
   * Appelée après l'analyse d'images pour affiner le scoring.
   */
  static applyImageAnalysis(ad) {
    if (!ad.marketAnalysis || !ad.imageAnalysis) return ad;

    const vision = ad.imageAnalysis;
    let score = ad.marketAnalysis.score;
    let scamScore = ad.marketAnalysis.scamScore || 0;

    // Bonus/malus basé sur l'authenticité de la photo
    if (vision.photoType === 'STOCK_PHOTO') {
      // Photo constructeur = risque d'arnaque plus élevé
      scamScore = Math.min(99, scamScore + 10);
      score -= 5;
    } else if (vision.photoType === 'REAL_PRODUCT') {
      // Photo authentique = confiance accrue
      score += 5;
    }

    // Bonus/malus basé sur l'état visible
    const conditionMap = {
      NEW: 10,
      LIKE_NEW: 7,
      GOOD: 3,
      WORN: -8,
      DAMAGED: -20,
    };
    score += conditionMap[vision.visibleCondition] || 0;

    // Malus si défauts visibles détectés
    if (Array.isArray(vision.visibleDefects) && vision.visibleDefects.length > 0) {
      score -= vision.visibleDefects.length * 5;
    }

    // Bonus si l'authenticité est haute
    if (vision.authenticityScore >= 80) {
      score += 3;
    } else if (vision.authenticityScore < 30) {
      score -= 5;
    }

    score = Math.max(0, Math.min(100, score));

    // Recalcul de la classification
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

    ad.marketAnalysis = {
      ...ad.marketAnalysis,
      score,
      classification,
      badgeClass,
      scamScore,
      photoType: vision.photoType,
      visionSummary: vision.summary,
      visibleCondition: vision.visibleCondition,
      visibleDefects: vision.visibleDefects,
      authenticityScore: vision.authenticityScore,
    };

    return ad;
  }
}

module.exports = { MarketAnalyzer };