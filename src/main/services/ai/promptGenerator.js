'use strict';

/**
 * PromptGenerator — génère des prompts d'analyse personnalisés via une IA
 * LOCALE (Ollama), au lieu d'une IA sur le web.
 *
 * Aucune clé API, aucune requête vers internet : tout passe par le serveur
 * Ollama local (http://127.0.0.1:11434 par défaut). Réutilise la même logique
 * de fetch / timeout (AbortController) que marketAnalyzer.
 *
 * Mission : produire un prompt d'analyse détaillé adapté au domaine et à
 * l'objectif de l'utilisateur. Ce prompt est ensuite collé dans Google AI
 * Studio avec le fichier d'annonces.
 */

const { truncate, formatMs } = require('../../utils/diagnostics');

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'llama3';

// Méta-instructions : ce que l'IA locale doit PRODUIRE (un prompt, pas une
// analyse). On lui fournit contexte + variables, il génère le prompt final
// à coller dans AI Studio avec le fichier d'annonces.
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
   * Génère un prompt d'analyse personnalisé via Ollama (local).
   * @param {Object} input { domain, objective, customHints, vars, ollamaUrl, ollamaModel }
   * @param {Function} onProgress callback optionnel {percent,status}
   * @returns {Promise<string>} le prompt généré (texte)
   */
  static async generate(input = {}, onProgress) {
    const {
      domain = 'produits',
      objective = 'Trouve les meilleures affaires et opportunités d\'achat-revente.',
      customHints = '',
      vars = {},
      ollamaUrl = DEFAULT_OLLAMA_URL,
      ollamaModel = DEFAULT_MODEL,
    } = input;

    if (!ollamaUrl) throw new Error('URL Ollama manquante.');
    if (!ollamaModel) throw new Error('Modèle Ollama manquant.');

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

    console.log(`[PromptGenerator] Génération locale Ollama — domain=${domain} | model=${ollamaModel} | url=${ollamaUrl} | prompt=${truncate(metaPrompt, 80)}`);

    if (onProgress) onProgress({ percent: 30, status: `Appel à Ollama (${ollamaModel})…` });

    let raw;
    const t0 = Date.now();
    try {
      raw = await this._callOllama(metaPrompt, ollamaUrl, ollamaModel, onProgress);
    } catch (err) {
      console.error(`[PromptGenerator] Échec génération après ${formatMs(Date.now() - t0)} : ${err.message}`);
      throw err;
    }
    console.log(`[PromptGenerator] Prompt généré en ${formatMs(Date.now() - t0)} (${truncate(raw, 60)}).`);

    if (onProgress) onProgress({ percent: 100, status: 'Prompt généré.' });

    return raw.trim();
  }

  static async _callOllama(prompt, ollamaUrl, model, onProgress) {
    const base = (ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/$/, '');
    const url = `${base}/api/generate`;
    const controller = new AbortController();
    // Ollama local peut être lent sur un gros prompt — timeout généreux (3 min).
    const timer = setTimeout(() => controller.abort(), 180000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || DEFAULT_MODEL,
          prompt,
          stream: false,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = await res.text().catch(() => '');
      } catch (_) {}
      console.error(`[PromptGenerator] Ollama HTTP ${res.status} : ${truncate(detail, 200)}`);
      if (res.status === 404) {
        throw new Error(`Ollama a répondu 404 — le modèle « ${model} » n'est pas installé. Lancez : ollama pull ${model}`);
      }
      throw new Error(`Ollama a répondu HTTP ${res.status}. Vérifiez que le serveur Ollama est démarré.`);
    }

    const data = await res.json();
    const text = data && (data.response || data.message || '');
    if (!text) throw new Error('Réponse Ollama vide (pas de texte généré).');
    return text.trim();
  }
}

module.exports = { PromptGenerator };

