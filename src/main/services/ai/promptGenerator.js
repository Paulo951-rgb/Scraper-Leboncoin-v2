'use strict';

/**
 * PromptGenerator — IA 3 : génération de prompts pour le module AI Studio.
 *
 * Indépendante des IA 1 (Analyse) et IA 2 (Marché). Génère un PROMPT complet,
 * structuré et détaillé (≈50 lignes si nécessaire), adapté à N'IMPORTE QUEL
 * type de produit — même un type jamais traité auparavant (plantes, meubles,
 * voitures, livres…). L'IA déduit les critères pertinents à rechercher pour
 * la catégorie fournie.
 *
 * Utilise AIProvider (Ollama local aujourd'hui, infra distante demain) au lieu
 * d'un fetch direct → cohérent avec le reste de l'architecture IA.
 */

const { getAIProvider } = require('./providers/aiProviderRegistry');
const { truncate, formatMs } = require('../../utils/diagnostics');

const GENERATION_TIMEOUT_MS = 180000;

// Méta-instructions : l'IA locale doit PRODUIRE un prompt (pas une analyse).
const META_SYSTEM = `Tu es un ingénieur de prompts expert en analyse d'annonces de vente en ligne (Leboncoin et sites équivalents) pour l'achat-revente et la détection de bonnes affaires.
On te donne un contexte (type de produit, objectif, fourchette de prix, classements souhaités, consignes) et tu dois générer un PROMPT complet, très détaillé et prêt à coller dans Google AI Studio.

Le prompt que tu génères sera envoyé avec un fichier .json contenant plusieurs centaines/milliers d'annonces issues d'une recherche Leboncoin. L'IA qui recevra ce prompt devra analyser TOUTES les annonces et produire des classements pertinents.

RÈGLES OBLIGATOIRES pour le prompt que tu génères :
1. Contexte : commence par définir clairement le rôle de l'IA cible (expert en achat-revente, spécialiste du type de produit) et l'objectif précis.
2. Critères pertinents : DÉDUIS TOI-MÊME les critères importants pour le type de produit fourni, même s'il s'agit d'une catégorie inédite (plantes, meubles, voitures, livres, électroménager…). Pour chaque type, identifie ce qui fait la valeur : marque/modèle, état, défauts, authenticité, rareté, accessoires, dimensions, année, kilométrage, édition, état de fonctionnement, etc.
3. Analyse exhaustive : exige l'analyse de 100 % des annonces, sans en oublier, sans se limiter à la recherche initiale.
4. Pour chaque annonce intéressante : modèle précis, prix demandé, valeur réelle estimée, état réel, défauts/éléments manquants, recommandation (Acheter / Négocier / Surveiller / Éviter).
5. Classements finaux : demande TOUS les classements demandés (meilleures affaires, lots, composants récupérables, pépites sous-évaluées, produits à éviter, etc.) avec le Top N précisé.
6. Détection d'arnaques : suspicion (Faible/Moyen/Élevé) sans jamais affirmer, prix aberrants, photos incohérentes, annonces vagues.
7. Opportunités indirectes : composants récupérables, lots, machines en panne, produits réparables.
8. Fourchette de prix : si fournie, filtre et prends-la en compte.
9. Format de sortie : précise un format structuré (tableaux Markdown, JSON, ou sections claires) pour chaque classement.
10. Robustesse : demande de signaler les annonces incomplètes, sans photo, ou à identifier avec prudence.

Le prompt généré doit être long, structuré et complet (typiquement 40-60 lignes). Réponds UNIQUEMENT avec le prompt final (texte), sans préambule, sans explication, sans markdown autour.`;

class PromptGenerator {
  /**
   * Génère un prompt d'analyse complet via AIProvider (Ollama local).
   * @param {Object} input { domain, objective, customHints, vars,
   *                         priceRange, topN, rankings,
   *                         provider, textModel, ollamaUrl }
   * @param {Function} onProgress callback {percent,status}
   * @returns {Promise<string>} le prompt généré (texte)
   */
  static async generate(input = {}, onProgress) {
    const {
      domain = 'produits',
      objective = "Trouve les meilleures affaires et opportunités d'achat-revente.",
      customHints = '',
      vars = {},
      priceRange = null,
      topN = 10,
      rankings = [],
      provider = 'ollama',
      textModel,
      ollamaUrl,
    } = input;

    const aiConfig = { provider, ...(textModel ? { textModel } : {}), ...(ollamaUrl ? { ollamaUrl } : {}) };

    if (onProgress) onProgress({ percent: 10, status: 'Construction du contexte…' });

    const varsBlock = Object.entries(vars)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');

    const rankingsBlock = Array.isArray(rankings) && rankings.length > 0
      ? rankings.map((r) => `- ${r}`).join('\n')
      : '- Meilleures affaires (achat-revente)';

    const priceBlock = priceRange && (priceRange.min != null || priceRange.max != null)
      ? `Fourchette de prix : ${priceRange.min != null ? priceRange.min + ' €' : '—'} à ${priceRange.max != null ? priceRange.max + ' €' : '—'}`
      : '(fourchette non précisée — analyse toutes les gammes de prix)';

    const userContext = `Type de produit / domaine : ${domain}
Objectif de l'analyse : ${objective}
${priceBlock}
Top des résultats souhaité : Top ${topN}
Classements demandés :
${rankingsBlock}
${customHints ? `Consignes supplémentaires de l'utilisateur : ${customHints}\n` : ''}Variables / contexte complémentaire :
${varsBlock || '(aucune)'}

Génère maintenant le prompt complet, structuré et détaillé à coller dans AI Studio. DÉDUIS les critères pertinents pour ce type de produit (« ${domain} »), même si tu n'as jamais traité cette catégorie.`;

    const metaPrompt = `${META_SYSTEM}

=== CONTEXTE FOURNI PAR L'UTILISATEUR ===
${userContext}`;

    console.log(`[PromptGenerator] Génération ${provider} — domain=${domain} | top=${topN} | prompt=${truncate(metaPrompt, 80)}`);

    if (onProgress) onProgress({ percent: 30, status: `Appel à l'IA (${textModel || 'défaut'})…` });

    let raw;
    const t0 = Date.now();
    try {
      const ai = getAIProvider(aiConfig);
      // Le meta-prompt de génération est long (~3000+ caractères) : on monte le
      // contexte Ollama pour éviter une sortie tronquée (défaut 2048 trop petit).
      raw = await ai.chatText(metaPrompt, { temperature: 0.4, timeoutMs: GENERATION_TIMEOUT_MS, numCtx: 8192 });
    } catch (err) {
      console.error(`[PromptGenerator] Échec génération après ${formatMs(Date.now() - t0)} : ${err.message}`);
      throw err;
    }
    console.log(`[PromptGenerator] Prompt généré en ${formatMs(Date.now() - t0)} (${truncate(raw, 60)}).`);

    if (onProgress) onProgress({ percent: 100, status: 'Prompt généré.' });

    return raw.trim();
  }
}

module.exports = { PromptGenerator };

