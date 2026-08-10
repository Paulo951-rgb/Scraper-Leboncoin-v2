'use strict';

/**
 * PromptGenerator — génère des prompts d'analyse personnalisés via Gemini,
 * au lieu d'utiliser des prompts statiques pré-enregistrés.
 *
 * Réutilise le même endpoint Gemini que GlobalAnalyzer (et la même logique
 * de fetch / retry) mais avec une mission différente : produire un prompt
 * détaillé adapté au domaine et à l'objectif de l'utilisateur.
 */

const { truncate, formatBytes, formatMs, redact } = require('../../utils/diagnostics');
const { sleep } = require('../../utils/helpers');

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Méta-instructions : ce que l'IA doit PRODUIRE (un prompt, pas une analyse).
// On lui fournit contexte + variables, il génère le prompt final à coller
// dans AI Studio avec le fichier d'annonces.
const META_SYSTEM = `Tu es un ingénieur de prompts expert en analyse d'annonces Leboncoin pour l'achat-revente.
On te donne un contexte (domaine, recherche, variables) et tu dois générer un PROMPT complet, détaillé et prêt à coller dans Google AI Studio.

Le prompt que tu génères sera envoyé avec un fichier .json contenant plusieurs centaines/milliers d'annonces issues d'une recherche Leboncoin.

RÈGLES pour le prompt que tu génères :
- Analyse 100 % des annonces, sans en oublier, sans se limiter à la recherche initiale.
- Demande des classements finaux Top N (meilleures affaires, achat-revente, composants, pépites sous-évaluées, à éviter).
- Demande pour chaque annonce intéressante : catégorie, prix demandé, valeur réelle estimée, score /100, recommandation (Acheter/Négocier/Surveiller/Éviter), risques.
- Détection d'arnaques (niveau Faible/Moyen/Élevé, "suspicion" sans certitude).
- Opportunités indirectes (composants récupérables, lots, machines en panne).
- Adapte le vocabulaire et les critères au DOMAINE fourni (hardware, livres, smartphones, etc.).
- Réponds UNIQUEMENT avec le prompt final (texte), sans préambule ni explication, sans markdown autour.

Voici le contexte fourni par l'utilisateur :`;

class PromptGenerator {
  /**
   * Génère un prompt d'analyse personnalisé via Gemini.
   * @param {Object} input { domain, objective, customHints, vars, geminiApiKey, geminiModel }
   * @param {Function} onProgress callback optionnel {percent,status}
   * @returns {Promise<string>} le prompt généré (texte)
   */
  static async generate(input = {}, onProgress) {
    const {
      domain = 'produits',
      objective = 'Trouve les meilleures affaires et opportunités d\'achat-revente.',
      customHints = '',
      vars = {},
      geminiApiKey,
      geminiModel = 'gemini-2.0-flash',
    } = input;

    if (!geminiApiKey) throw new Error('Clé API Gemini manquante (nécessaire pour générer le prompt).');

    if (onProgress) onProgress({ percent: 10, status: 'Construction du contexte…' });

    const varsBlock = Object.entries(vars)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');

    const userContext = `Domaine : ${domain}
Objectif de l'analyse : ${objective}
${customHints ? `Consignes supplémentaires : ${customHints}\n` : ''}Variables (à intégrer dans le prompt généré) :
${varsBlock || '(aucune)'}

Génère maintenant le prompt complet à coller dans AI Studio.`;

    const metaPrompt = `${META_SYSTEM}

${userContext}`;

    console.log(`[PromptGenerator] Génération — domain=${domain} | model=${geminiModel} | apiKey=${redact(geminiApiKey)} | prompt=${formatBytes(Buffer.byteLength(metaPrompt, 'utf8'))}`);

    if (onProgress) onProgress({ percent: 30, status: 'Appel à Gemini…' });

    let raw;
    const t0 = Date.now();
    try {
      raw = await this._callGeminiWithRetry(metaPrompt, geminiApiKey, geminiModel, onProgress);
    } catch (err) {
      console.error(`[PromptGenerator] Échec génération après ${formatMs(Date.now() - t0)} : ${err.message}`);
      throw err;
    }
    console.log(`[PromptGenerator] Prompt généré en ${formatMs(Date.now() - t0)} (${truncate(raw, 60)}).`);

    if (onProgress) onProgress({ percent: 100, status: 'Prompt généré.' });

    // Nettoyage : retirer d'éventuels délimiteurs markdown (```...```)
    return raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  }

  static async _callGeminiWithRetry(prompt, apiKey, model, onProgress, maxRetries = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this._callGemini(prompt, apiKey, model);
      } catch (err) {
        lastErr = err;
        const isRetryable = err.message.includes('429') || err.message.includes('503');
        if (!isRetryable || attempt >= maxRetries) throw err;
        const retryMatch = err.message.match(/retry in ([\d.]+)s/i);
        const waitSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : 15 * attempt;
        const msg = `⏳ Quota Gemini (429). Nouvelle tentative ${attempt + 1}/${maxRetries} dans ${waitSec}s…`;
        console.warn(`[PromptGenerator] ${msg}`);
        if (onProgress) onProgress({ percent: 30, status: msg });
        await sleep(waitSec * 1000);
      }
    }
    throw lastErr;
  }

  static async _callGemini(prompt, apiKey, model) {
    const url = `${GEMINI_ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7 },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let detail = '';
      try {
        const errBody = await res.json();
        detail = errBody?.error?.message || JSON.stringify(errBody);
      } catch {
        detail = await res.text().catch(() => '');
      }
      console.error(`[PromptGenerator] Gemini HTTP ${res.status} : ${truncate(detail, 200)}`);
      if (res.status === 429) throw new Error(`Quota Gemini dépassé (429). ${detail.slice(0, 300)}`);
      if (res.status === 400) throw new Error(`Requête Gemini invalide (400) : ${truncate(detail, 200)}. Vérifiez le modèle (${model}).`);
      if (res.status === 401 || res.status === 403) throw new Error(`Clé API Gemini invalide (${res.status}).`);
      throw new Error(`Erreur Gemini (HTTP ${res.status}) : ${truncate(detail, 200)}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Réponse Gemini vide (pas de texte généré).');
    return text.trim();
  }
}

module.exports = { PromptGenerator };
